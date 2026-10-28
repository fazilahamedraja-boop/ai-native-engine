import fs from 'node:fs'
import path from 'node:path'

import {
  REPO_ROOT,
  StudioError,
  hashTree,
  isInside,
  newId,
  sha256File,
  writeJsonAtomic,
} from './studio-paths.mjs'
import { JobStore, findJobOrThrow, isJobId, jobRelativeArtifact } from './jobs.mjs'
import { classifyProviderError, summarizeTranscript } from './provider-errors.mjs'
import { runFixed } from './process.mjs'
import { projectRoot } from './projects.mjs'
import {
  buildUnifiedDiff,
  copyProject,
  diffTrees,
  scopeProblems,
  unifiedDiff,
} from './workspace.mjs'
import {
  collectGdScripts,
  runHiddenSuite,
  runNativeSmoke,
  runScriptTest,
  staticCheckProject,
} from './verification.mjs'

const DEFAULT_LIMITS = Object.freeze({
  maxAttempts: 2,
  attemptTimeoutMs: 600000,
  maxRuntimeMs: 20 * 60 * 1000,
})

class CancelledError extends Error {}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new CancelledError('The job was cancelled.')
}

function bounded(text, limit = 4000) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n… truncated (${value.length} bytes)` : value
}

/**
 * Turn a project's agent policy into the options understood by `scopeProblems`.
 * Projects that only name exact files keep the strict repair behaviour; a
 * template with `allowedPatterns` opts into bounded feature implementation
 * (additions allowed inside the named trees, protected paths still refused).
 */
function scopeOptions(project) {
  const agent = project.agent ?? {}
  const patterns = Array.isArray(agent.allowedPatterns) ? agent.allowedPatterns : []
  if (patterns.length === 0) return {}
  return {
    patterns,
    allowAdditions: agent.allowAdditions === true,
    protectedPaths: Array.isArray(agent.protectedPaths) ? agent.protectedPaths : [],
  }
}

function firstFailures(result, limit = 8) {  const lines = []
  for (const entry of result?.results ?? []) {
    if (entry && entry.passed === false) lines.push(`- ${entry.name}: ${entry.detail ?? 'failed'}`)
  }
  for (const error of result?.errors ?? []) lines.push(`- ${error}`)
  if (lines.length === 0 && result?.reason) lines.push(`- ${result.reason}`)
  return lines.slice(0, limit)
}

export function createAgentRunner({
  store = new JobStore(),
  projects,
  deps = {},
} = {}) {
  if (!projects) throw new Error('createAgentRunner requires the project registry')
  const {
    copyProjectImpl = copyProject,
    hashTreeImpl = hashTree,
    diffTreesImpl = diffTrees,
    staticCheckProjectImpl = staticCheckProject,
    runScriptTestImpl = runScriptTest,
    runHiddenSuiteImpl = runHiddenSuite,
    runNativeSmokeImpl = runNativeSmoke,
    runFixedImpl = runFixed,
    runAgentImpl = defaultAgentRun,
    prepareImportsImpl = prepareWorkspaceImports,
    projectRootImpl = projectRoot,
    now = () => new Date(),
    gitCommit = defaultGitCommit,
  } = deps

  const controllers = new Map()

  function paths(jobId) {
    return store.paths(jobId)
  }

  function update(jobId, patch) {
    return store.update(jobId, patch)
  }

  function event(jobId, type, message, data = null, level = 'info') {
    return store.appendEvent(jobId, { type, message, data, level })
  }

  async function start(jobId) {
    const job = findJobOrThrow(store, jobId)
    if (job.status !== 'queued') throw new StudioError('invalid_state', 'Only a queued job can start.', 409)
    const controller = new AbortController()
    controllers.set(jobId, controller)
    void execute(job, controller).finally(() => controllers.delete(jobId))
    return findJobOrThrow(store, jobId)
  }

  async function execute(job, controller, { resume = false, previousJob = null } = {}) {
    const jobId = job.id
    const project = projects.getProject(job.projectId)
    const canonical = projectRootImpl(project)
    const pathsForJob = paths(jobId)
    const signal = controller.signal
    const startedAt = Date.now()
    const limits = { ...DEFAULT_LIMITS, ...(job.limits ?? {}) }

    try {
      update(jobId, { status: 'running', step: resume ? 'resume' : 'workspace', error: null })
      event(jobId, 'job.started', resume ? `Resuming with ${job.model}.` : `Starting ${project.name} task.`, {
        model: job.model,
        resume,
      }, 'success')

      if (!resume) {
        event(jobId, 'step.workspace', 'Copying the project into an isolated workspace.', { canonical })
        fs.rmSync(pathsForJob.workspace, { recursive: true, force: true })
        fs.rmSync(pathsForJob.baseline, { recursive: true, force: true })
        fs.mkdirSync(pathsForJob.workspace, { recursive: true })
        const hiddenName = project.hiddenTest && !project.hiddenTest.visibleInProject
          ? path.basename(project.hiddenTest.relative)
          : null
        copyProjectImpl(canonical, pathsForJob.workspace, {
          skipFiles: new Set(['opencode.json', 'TASK.md', 'STUDIO_FAILURE.md', ...(hiddenName ? [hiddenName] : [])]),
        })
        copyProjectImpl(pathsForJob.workspace, pathsForJob.baseline, { skipFiles: new Set(['TASK.md', 'STUDIO_FAILURE.md']) })
        const baselineHash = hashTreeImpl(pathsForJob.workspace)
        const commit = await gitCommit({ cwd: REPO_ROOT, runFixed: runFixedImpl })
        update(jobId, {
          startCommit: commit,
          baselineHash,
          workspaceHash: baselineHash,
          candidateHash: null,
          step: 'imports',
        })
        event(jobId, 'workspace.ready', `Workspace copied (${baselineHash.slice(0, 12)}).`, {
          baselineHash,
          startCommit: commit,
        }, 'success')

        assertNotAborted(signal)
        const importResult = await prepareImportsImpl({ projectDir: pathsForJob.workspace, runFixedImpl })
        event(jobId, 'workspace.imports', importResult.message, importResult, importResult.ok ? 'info' : 'warn')

        event(jobId, 'step.baseline', 'Running baseline checks and tests on the untouched copy.')
        const baseline = await runBaseline({ jobId, project, workspace: pathsForJob.workspace, signal })
        update(jobId, { baseline, step: 'baseline' })
        if (!baseline.ok) {
          const failure = baselineFailureMessage(baseline)
          event(jobId, 'baseline.failed', failure, baseline, 'error')
          update(jobId, {
            status: 'failed',
            step: 'baseline',
            error: { class: 'baseline_failed', message: failure, resumable: false },
          })
          return
        }
        event(jobId, 'baseline.passed', 'Baseline static checks and tests passed.', baseline, 'success')

        // Capture a real "before" frame where the project supports it.
        if (project.smoke) {
          event(jobId, 'step.before', 'Capturing a before frame from the untouched workspace.')
          const before = await runNativeSmokeImpl({
            projectDir: pathsForJob.workspace,
            project,
            outPng: path.join(pathsForJob.artifacts, 'before.png'),
            label: 'before',
          })
          setArtifact(jobId, 'before', before.screenshot ?? null)
          update(jobId, { beforeCapture: summarizeSmoke(before) })
          event(
            jobId,
            before.available ? 'evidence.before' : 'evidence.before_unavailable',
            before.available ? 'Before frame captured.' : before.reason,
            summarizeSmoke(before),
            before.available ? 'success' : 'warn',
          )
        }
      } else {
        event(jobId, 'resume.workspace', 'Retaining the verified workspace and its baseline evidence.', {
          workspaceHash: job.workspaceHash,
          baselineHash: job.baselineHash,
        })
      }

      assertNotAborted(signal)
      const attempts = Array.isArray(job.attempts) ? [...job.attempts] : []
      const maxAttempts = Math.max(1, Number(limits.maxAttempts) || DEFAULT_LIMITS.maxAttempts)
      let failureSummary = resume && previousJob?.lastFailure ? previousJob.lastFailure : ''
      let lastVerification = resume ? previousJob?.verification ?? null : null
      // A refusal that follows a failed verification must still tell the
      // operator *why* verification failed, so keep that one line separate from
      // the markdown repair handoff.
      let lastFailureLine = lastVerifiedFailureLine(previousJob)

      // Count attempts already used only within this run segment; a resume gets
      // a fresh bounded segment but keeps the historical attempt records.
      const segmentStart = attempts.length
      let segmentAttempts = 0
      while (segmentAttempts < maxAttempts) {
        assertNotAborted(signal)
        if (Date.now() - startedAt > limits.maxRuntimeMs) {
          throw new StudioError('timeout', 'The job exceeded its overall runtime limit.', 408)
        }
        segmentAttempts += 1
        const attemptNumber = attempts.length + 1
        const attemptDir = path.join(pathsForJob.attempts, `attempt-${attemptNumber}`)
        fs.mkdirSync(attemptDir, { recursive: true })
        const attempt = {
          attempt: attemptNumber,
          model: (findJobOrThrow(store, jobId).model ?? job.model),
          startedAt: now().toISOString(),
          status: 'running',
          agent: null,
          changedFiles: [],
          verification: null,
          failure: null,
        }
        attempts.push(attempt)
        update(jobId, { attempts, step: 'agent' })
        event(jobId, 'attempt.started', `Agent attempt ${attemptNumber} started.`, {
          attempt: attemptNumber,
          model: attempt.model,
        })

        const taskFile = path.join(pathsForJob.workspace, 'TASK.md')
        const failureFile = path.join(pathsForJob.workspace, 'STUDIO_FAILURE.md')
        fs.writeFileSync(taskFile, buildTaskMarkdown({ project, task: job.task, model: attempt.model }), 'utf8')
        if (failureSummary) fs.writeFileSync(failureFile, failureSummary, 'utf8')

        let agentResult
        try {
          agentResult = await runAgentImpl({
            job,
            project,
            workspace: pathsForJob.workspace,
            attemptDir,
            attemptNumber,
            model: attempt.model,
            signal,
            onEvent: (type, message, data, level) => event(jobId, type, message, data, level),
            runFixedImpl,
          })
        } finally {
          fs.rmSync(taskFile, { force: true })
          fs.rmSync(failureFile, { force: true })
        }

        attempt.agent = {
          code: agentResult.code,
          timedOut: agentResult.timedOut,
          aborted: agentResult.aborted,
          durationMs: agentResult.durationMs,
          classification: agentResult.classification,
          transcript: agentResult.transcriptRelative,
          stderr: agentResult.stderrRelative,
          summary: summarizeTranscript(agentResult.stdout),
        }
        attempt.finishedAt = now().toISOString()

        if (signal.aborted) {
          attempt.status = 'cancelled'
          attempt.failure = 'Cancelled by the operator. The transcript and partial workspace are preserved.'
          update(jobId, {
            attempts,
            workspaceHash: hashTreeImpl(pathsForJob.workspace),
          })
          throw new CancelledError('The job was cancelled.')
        }

        if (agentResult.classification.class !== 'none' || agentResult.code !== 0) {
          const classification =
            agentResult.classification.class === 'none'
              ? {
                  class: 'exited',
                  stop: true,
                  retryable: true,
                  message: `The agent exited with code ${agentResult.code}.`,
                }
              : agentResult.classification
          attempt.status = 'provider_failed'
          attempt.failure = classification.message
          update(jobId, { attempts, workspaceHash: hashTreeImpl(pathsForJob.workspace) })
          event(jobId, 'provider.failed', classification.message, classification, 'error')
          update(jobId, {
            status: 'failed',
            step: 'agent',
            error: {
              class: classification.class,
              message: classification.message,
              resumable: true,
              requiresModelSwitch: ['quota', 'auth', 'model'].includes(classification.class),
            },
            lastFailure: `# Provider failure\n\n- ${classification.message}\n\nSwitch model/provider or fix credentials, then resume. The workspace was preserved.`,
          })
          return
        }

        // TASK files are not part of the candidate.
        fs.rmSync(path.join(pathsForJob.workspace, 'TASK.md'), { force: true })
        fs.rmSync(path.join(pathsForJob.workspace, 'STUDIO_FAILURE.md'), { force: true })

        const candidateHash = hashTreeImpl(pathsForJob.workspace)
        const changed = diffTreesImpl(pathsForJob.baseline, pathsForJob.workspace)
        update(jobId, { candidateHash, workspaceHash: candidateHash, changedFiles: changed })
        attempt.changedFiles = changed
        event(jobId, 'workspace.changed', `${changed.length} file(s) differed from the baseline.`, {
          changed: changed.map((entry) => `${entry.status}:${entry.file}`),
          candidateHash,
        })

        const problems = scopeProblems(changed, project.agent.allowedFiles, scopeOptions(project))
        if (problems.length > 0) {
          const diff = buildUnifiedDiff(pathsForJob.baseline, pathsForJob.workspace, changed)
          store.writeArtifact(jobId, 'artifacts/diff.patch', diff)
          setArtifact(jobId, 'diff', artifactEntry(store, jobId, 'artifacts/diff.patch', 'text/plain'))
          // "Made no change" is a different refusal from "edited a file outside
          // the policy", and the message shown to the operator must say which.
          const noChange = changed.length === 0
          attempt.status = 'scope_violation'
          attempt.failure = problems.join('\n')
          update(jobId, { attempts })
          event(
            jobId,
            noChange ? 'scope.no_change' : 'scope.rejected',
            noChange
              ? 'The agent finished without changing an allowed file.'
              : 'The candidate changed files outside the allowed list.',
            { problems, changed },
            'error',
          )
          const afterVerifiedFailure = noChange && lastFailureLine
          update(jobId, {
            status: 'failed',
            step: 'verify',
            error: {
              class: 'scope_violation',
              message: afterVerifiedFailure
                ? `${problems.join(' ')} The earlier attempt failed verification: ${lastFailureLine}`
                : problems.join(' '),
              resumable: true,
              requiresModelSwitch: false,
            },
            lastFailure: afterVerifiedFailure
              ? `${failureSummary}\n\n# Repair made no change\n\n- ${problems.join('\n- ')}\n\nThe workspace and transcript were preserved; approve is disabled.`
              : `# Change rejected by the file policy\n\n${problems.map((item) => `- ${item}`).join('\n')}\n\nThe workspace and transcript were preserved; approve is disabled.`,
          })
          return
        }

        assertNotAborted(signal)
        update(jobId, { step: 'verify' })
        event(jobId, 'step.verify', 'Running independent verification on the candidate.')
        const verification = await verifyCandidate({
          jobId,
          job,
          project,
          workspace: pathsForJob.workspace,
          signal,
          runNativeSmokeImpl,
          prepareImportsImpl: prepareImportsImpl,
          event,
        })
        attempt.verification = verification
        lastVerification = verification
        update(jobId, { attempts, verification })

        if (!verification.ok) {
          const failures = verificationFailureLines(verification)
          attempt.status = 'verification_failed'
          attempt.failure = failures.join('\n')
          lastFailureLine = failures[0] ?? 'Verification failed.'
          failureSummary = `# Verified failure after attempt ${attemptNumber}\n\n${failures.map((line) => `- ${line}`).join('\n')}\n\nRepair the allowed file(s) in place. Do not edit tests or any other file.`
          update(jobId, { attempts, lastFailure: failureSummary })
          event(jobId, 'verify.failed', `Verification failed on attempt ${attemptNumber}.`, verification, 'error')
          if (segmentAttempts < maxAttempts) {
            event(jobId, 'attempt.retry', 'Starting a bounded repair attempt with the verified failure.', {
              attempt: attemptNumber,
            }, 'warn')
            continue
          }
          update(jobId, {
            status: 'failed',
            step: 'verify',
            error: {
              class: 'verification_failed',
              message: failures[0] ?? 'Verification failed.',
              resumable: true,
              requiresModelSwitch: false,
            },
          })
          return
        }

        attempt.status = 'passed'
        update(jobId, { attempts })
        writeEvidence(jobId, { job, project, verification, changed, store })
        event(jobId, 'verify.passed', 'Independent verification passed. Waiting for human approval.', verification, 'success')
        update(jobId, {
          status: 'awaiting_approval',
          step: 'awaiting_approval',
          error: null,
          candidateHash: hashTreeImpl(pathsForJob.workspace),
          workspaceHash: hashTreeImpl(pathsForJob.workspace),
          changedFiles: changed,
          verification,
          approval: null,
        })
        return
      }

      update(jobId, {
        status: 'failed',
        step: 'verify',
        error: {
          class: 'verification_failed',
          message: `No passing candidate after ${maxAttempts} attempt(s).`,
          resumable: true,
          requiresModelSwitch: false,
        },
        lastFailure: failureSummary || lastVerification?.summary || 'No passing candidate.',
      })
    } catch (error) {
      if (error instanceof CancelledError || signal.aborted) {
        try {
          update(jobId, { status: 'cancelled', step: 'cancelled', error: { class: 'cancelled', message: 'Cancelled by the operator.', resumable: true } })
          event(jobId, 'job.cancelled', 'Job cancelled by the operator. Transcript and workspace preserved.', null, 'warn')
        } catch {
          // If the manifest is gone, there is nothing left to update.
        }
        return
      }
      try {
        const message = bounded(error.message, 2000)
        update(jobId, {
          status: 'failed',
          step: 'error',
          error: { class: error.code ?? 'internal', message, resumable: false },
        })
        event(jobId, 'job.failed', message, { stack: bounded(error.stack, 4000) }, 'error')
      } catch {
        // Never crash the server because a job manifest could not be written.
      }
    }
  }

  async function runBaseline({ jobId, project, workspace, signal }) {
    assertNotAborted(signal)
    const check = await staticCheckProjectImpl({ projectDir: workspace, project })
    store.writeArtifact(jobId, 'artifacts/baseline-check.json', `${JSON.stringify(check, null, 2)}\n`)
    event(jobId, 'baseline.check', check.ok ? 'Baseline scripts parsed cleanly.' : 'Baseline scripts have errors.', {
      ok: check.ok,
      errors: check.errors.slice(0, 10),
      mode: check.mode,
    }, check.ok ? 'success' : 'error')
    const tests = []
    for (const suite of project.tests) {
      assertNotAborted(signal)
      if (suite.baseline === false) {
        tests.push({
          id: suite.id,
          label: suite.label,
          script: suite.script,
          available: true,
          ok: true,
          skipped: true,
          reason: 'This suite describes the finished game, so the untouched baseline is not expected to pass it.',
          summary: { passed: 0, failed: 0 },
        })
        event(jobId, 'baseline.test_skipped', `${suite.label}: skipped on the untouched baseline by template policy.`, {
          id: suite.id,
        }, 'info')
        continue
      }
      const result = await runScriptTestImpl({
        projectDir: workspace,
        script: suite.script,
        timeoutMs: suite.timeoutMs,
        expectedDiagnostics: suite.expectedDiagnostics ?? [],
      })
      tests.push({ id: suite.id, label: suite.label, script: suite.script, ...result })
      event(
        jobId,
        'baseline.test',
        `${suite.label}: ${result.summary?.passed ?? 0} passed, ${result.summary?.failed ?? 0} failed.`,
        { id: suite.id, ok: result.ok, summary: result.summary },
        result.ok ? 'success' : 'error',
      )
    }
    store.writeArtifact(jobId, 'artifacts/baseline-tests.json', `${JSON.stringify(tests, null, 2)}\n`)
    return {
      ok: check.ok && tests.every((entry) => entry.ok),
      check,
      tests,
      at: now().toISOString(),
    }
  }

  async function verifyCandidate({
    jobId,
    job,
    project,
    workspace,
    signal,
    runNativeSmokeImpl: smoke,
    prepareImportsImpl: prepare,
    event: emit,
  }) {
    const steps = []
    assertNotAborted(signal)
    const imported = await prepare({ projectDir: workspace })
    steps.push({
      id: 'import',
      label: 'Godot import of the candidate',
      ok: Boolean(imported.ok),
      available: true,
      durationMs: imported.durationMs ?? null,
      reason: imported.message,
    })
    emit(
      jobId,
      'verify.import',
      imported.message,
      { ok: Boolean(imported.ok), durationMs: imported.durationMs ?? null },
      imported.ok ? 'success' : 'error',
    )
    assertNotAborted(signal)
    const check = await staticCheckProjectImpl({ projectDir: workspace, project })
    steps.push({
      id: 'static',
      label: 'Candidate script diagnostics',
      ok: check.ok,
      available: check.available,
      mode: check.mode,
      errors: check.errors.slice(0, 20),
      warnings: check.warnings.slice(0, 20),
      fileCount: check.fileCount,
    })
    emit(jobId, 'verify.static', check.ok ? 'Candidate scripts parsed cleanly.' : 'Candidate script diagnostics failed.', {
      ok: check.ok,
      mode: check.mode,
      errors: check.errors.slice(0, 10),
    }, check.ok ? 'success' : 'error')

    for (const suite of project.tests) {
      assertNotAborted(signal)
      const result = await runScriptTestImpl({
        projectDir: workspace,
        script: suite.script,
        timeoutMs: suite.timeoutMs,
        expectedDiagnostics: suite.expectedDiagnostics ?? [],
      })
      steps.push({
        id: `test:${suite.id}`,
        label: suite.label,
        ok: result.ok,
        available: result.available !== false,
        summary: result.summary,
        reason: result.reason,
        durationMs: result.durationMs,
        failures: firstFailures(result),
      })
      emit(
        jobId,
        'verify.test',
        `${suite.label}: ${result.summary?.passed ?? 0} passed, ${result.summary?.failed ?? 0} failed.`,
        { id: suite.id, ok: result.ok, summary: result.summary, failures: firstFailures(result).slice(0, 3) },
        result.ok ? 'success' : 'error',
      )
    }

    assertNotAborted(signal)
    const hidden = await runHiddenSuiteImpl({ workspace, project })
    steps.push({
      id: 'hidden',
      label: project.hiddenTest?.label ?? 'Hidden acceptance suite',
      ok: hidden.ok,
      available: hidden.available !== false,
      skipped: Boolean(hidden.skipped),
      summary: hidden.summary,
      reason: hidden.reason ?? null,
      failures: firstFailures(hidden),
    })
    emit(
      jobId,
      'verify.hidden',
      hidden.available === false
        ? `Hidden suite unavailable: ${hidden.reason}`
        : `${project.hiddenTest?.label ?? 'Hidden suite'}: ${hidden.summary?.passed ?? 0} passed, ${hidden.summary?.failed ?? 0} failed.`,
      { ok: hidden.ok, summary: hidden.summary, reason: hidden.reason },
      hidden.ok ? 'success' : hidden.available === false ? 'warn' : 'error',
    )

    let gameplay = null
    if (project.smoke) {
      assertNotAborted(signal)
      emit(jobId, 'verify.gameplay', 'Launching the candidate in a real window for playback evidence.')
      gameplay = await smoke({
        projectDir: workspace,
        project,
        outPng: path.join(paths(jobId).artifacts, 'after.png'),
        label: 'after',
      })
      setArtifact(jobId, 'after', gameplay.screenshot ?? null)
      steps.push({
        id: 'gameplay',
        label: 'Native window, capture and input',
        ok: gameplay.available === false ? true : gameplay.ok,
        available: gameplay.available !== false,
        skipped: Boolean(gameplay.skipped),
        reason: gameplay.reason,
        inputVerified: Boolean(gameplay.inputVerified),
        movement: gameplay.movement ?? null,
        screenshot: gameplay.screenshot ?? null,
      })
      emit(
        jobId,
        'verify.gameplay.result',
        gameplay.reason,
        summarizeSmoke(gameplay),
        gameplay.available === false ? 'warn' : gameplay.ok ? 'success' : 'error',
      )
    }

    store.writeArtifact(jobId, 'artifacts/verification.json', `${JSON.stringify(steps, null, 2)}\n`)
    const required = steps.filter((step) => step.id !== 'gameplay')
    const gameplayOk = !project.smoke || !gameplay || gameplay.available === false || gameplay.ok
    const stepPass = (step) => step.ok === true || step.skipped === true
    return {
      ok: required.every(stepPass) && gameplayOk,
      verifiedAt: now().toISOString(),
      steps,
      summary: steps.map((step) => `${step.ok ? 'PASS' : 'FAIL'} ${step.label}`).join(' · '),
      gameplay: gameplay ? summarizeSmoke(gameplay) : null,
    }
  }

  function writeEvidence(jobId, { job, project, verification, changed, store: jobStore }) {
    const pathsForJob = paths(jobId)
    const diff = buildUnifiedDiff(pathsForJob.baseline, pathsForJob.workspace, changed)
    jobStore.writeArtifact(jobId, 'artifacts/diff.patch', diff)
    const manifest = {
      schema: 'studio.candidate.v1',
      jobId,
      projectId: project.id,
      model: job.model,
      task: job.task,
      baselineHash: job.baselineHash,
      candidateHash: job.candidateHash,
      changedFiles: changed,
      verification,
      generatedAt: now().toISOString(),
    }
    jobStore.writeArtifact(jobId, 'artifacts/candidate.json', `${JSON.stringify(manifest, null, 2)}\n`)
    setArtifact(jobId, 'diff', artifactEntry(jobStore, jobId, 'artifacts/diff.patch', 'text/plain'))
    setArtifact(jobId, 'candidate', artifactEntry(jobStore, jobId, 'artifacts/candidate.json', 'application/json'))
    setArtifact(jobId, 'verification', artifactEntry(jobStore, jobId, 'artifacts/verification.json', 'application/json'))
  }

  function setArtifact(jobId, key, entry) {
    const job = findJobOrThrow(store, jobId)
    if (!entry) return
    update(jobId, {
      artifacts: {
        ...(job.artifacts ?? {}),
        [key]: jobRelativeArtifact(store.paths(jobId).dir, entry),
      },
    })
  }

  async function cancel(jobId) {
    const job = findJobOrThrow(store, jobId)
    if (job.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
    if (!['queued', 'running', 'awaiting_approval'].includes(job.status)) {
      throw new StudioError('invalid_state', `Cannot cancel a ${job.status} job.`, 409)
    }
    if (job.status === 'awaiting_approval') {
      return discard(jobId)
    }
    if (job.status === 'queued') {
      // Nothing has started yet, so there is no controller to abort. Mark the
      // job cancelled directly instead of leaving a queued job that can start.
      const updated = update(jobId, {
        status: 'cancelled',
        step: 'cancelled',
        error: { class: 'cancelled', message: 'Cancelled before it started.', resumable: false },
      })
      event(jobId, 'job.cancelled', 'Job cancelled before it started.', null, 'warn')
      return updated
    }
    const controller = controllers.get(jobId)
    if (controller) controller.abort()
    event(jobId, 'job.cancel_requested', 'Cancellation requested; the workspace and transcript are preserved.', null, 'warn')
    return findJobOrThrow(store, jobId)
  }

  async function discard(jobId) {
    const job = findJobOrThrow(store, jobId)
    if (job.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
    if (job.status === 'applied') {
      store.discardWorkspace(jobId)
      const cleaned = update(jobId, { workspaceHash: null, workspaceCleanedAt: now().toISOString() })
      event(jobId, 'job.workspace_cleaned', 'Applied job workspace deleted; artifacts and transcript preserved.', null, 'warn')
      return cleaned
    }
    store.discardWorkspace(jobId)
    const updated = update(jobId, {
      status: 'discarded',
      step: 'discarded',
      discardedAt: now().toISOString(),
      workspaceHash: null,
    })
    event(jobId, 'job.discarded', 'Disposable workspace deleted. Evidence and transcript were preserved.', null, 'warn')
    return updated
  }

  async function approve(jobId) {
    const job = findJobOrThrow(store, jobId)
    if (job.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
    if (job.status !== 'awaiting_approval') {
      throw new StudioError('invalid_state', 'Only a verified, awaiting-approval job can be applied.', 409)
    }
    if (!job.verification?.ok) throw new StudioError('not_verified', 'The candidate has not passed verification.', 409)

    const project = projects.getProject(job.projectId)
    const pathsForJob = paths(jobId)
    const currentHash = hashTreeImpl(pathsForJob.workspace)
    if (currentHash !== job.candidateHash) {
      update(jobId, {
        status: 'failed',
        error: {
          class: 'resume_conflict',
          message: 'The workspace changed after verification. Approval was refused.',
          resumable: false,
        },
        resume: { ...(job.resume ?? {}), conflict: { expected: job.candidateHash, actual: currentHash, at: now().toISOString() } },
      })
      event(jobId, 'approval.conflict', 'Workspace hash no longer matches the verified candidate.', {
        expected: job.candidateHash,
        actual: currentHash,
      }, 'error')
      throw new StudioError('resume_conflict', 'The verified workspace hash no longer matches. Re-verify before approving.', 409)
    }

    const changed = diffTreesImpl(pathsForJob.baseline, pathsForJob.workspace)
    const problems = scopeProblems(changed, project.agent.allowedFiles, scopeOptions(project))
    if (problems.length > 0) {
      throw new StudioError('scope_violation', problems.join(' '), 409)
    }

    const canonical = projectRootImpl(project)
    const applied = []
    for (const entry of changed) {
      if (entry.status !== 'modified' && entry.status !== 'added') continue
      const source = path.join(pathsForJob.workspace, entry.file)
      const target = path.join(canonical, entry.file)
      if (!isInside(target, canonical)) throw new StudioError('path_outside_root', 'Refused to write outside the project.', 500)
      if (entry.status === 'modified') {
        if (!fs.existsSync(target)) {
          throw new StudioError('missing_target', `Canonical file is missing: ${entry.file}`, 409)
        }
        const canonicalHash = sha256File(target)
        if (canonicalHash !== entry.beforeSha256) {
          throw new StudioError(
            'canonical_changed',
            `${entry.file} changed in the canonical project after this job started. Refusing to overwrite it.`,
            409,
          )
        }
        const temp = `${target}.studio-${newId('apply')}.tmp`
        fs.copyFileSync(source, temp)
        fs.renameSync(temp, target)
        applied.push({ file: entry.file, status: 'modified', beforeSha256: canonicalHash, afterSha256: sha256File(target), bytes: fs.statSync(target).size })
        continue
      }
      // An added file is written only if it is genuinely new in the canonical
      // project, so approval can never silently overwrite someone else's work.
      if (fs.existsSync(target)) {
        throw new StudioError(
          'canonical_changed',
          `${entry.file} already exists in the canonical project. Refusing to overwrite it.`,
          409,
        )
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const temp = `${target}.studio-${newId('apply')}.tmp`
      fs.copyFileSync(source, temp)
      fs.renameSync(temp, target)
      applied.push({ file: entry.file, status: 'added', beforeSha256: null, afterSha256: sha256File(target), bytes: fs.statSync(target).size })
    }

    const updated = update(jobId, {
      status: 'applied',
      step: 'applied',
      approval: {
        approvedAt: now().toISOString(),
        appliedFiles: applied,
        candidateHash: job.candidateHash,
      },
      workspaceHash: null,
    })
    event(jobId, 'approval.applied', `Applied ${applied.length} file(s) to the canonical project.`, { applied }, 'success')
    // Keep the workspace for audit; discard remains an explicit separate action.
    return updated
  }

  async function resume(jobId, { model } = {}) {
    const job = findJobOrThrow(store, jobId)
    if (job.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
    if (!['failed', 'cancelled'].includes(job.status)) {
      throw new StudioError('invalid_state', 'Only a failed or cancelled job can be resumed.', 409)
    }
    if (job.error?.class === 'resume_conflict') {
      throw new StudioError('resume_conflict', 'Resolve the workspace conflict before resuming.', 409)
    }
    const nextModel = String(model ?? job.model ?? '').trim()
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(nextModel) || nextModel.length > 160) {
      throw new StudioError('invalid_model', 'Model must look like provider/model.', 400)
    }
    if (job.error?.requiresModelSwitch && nextModel === job.model) {
      throw new StudioError(
        'model_switch_required',
        'This failure was a quota, authentication or model error. Choose a different model/provider before resuming.',
        400,
      )
    }
    const workspace = paths(jobId).workspace
    if (!fs.existsSync(workspace)) {
      throw new StudioError('workspace_missing', 'The job workspace no longer exists; start a new job.', 409)
    }
    const currentHash = hashTreeImpl(workspace)
    if (job.workspaceHash && currentHash !== job.workspaceHash) {
      update(jobId, {
        status: 'failed',
        resume: { ...(job.resume ?? {}), conflict: { expected: job.workspaceHash, actual: currentHash, at: now().toISOString() } },
        error: {
          class: 'resume_conflict',
          message: 'The workspace hash changed while the job was stopped.',
          resumable: false,
        },
      })
      event(jobId, 'resume.conflict', 'Workspace hash mismatch; resume refused.', {
        expected: job.workspaceHash,
        actual: currentHash,
      }, 'error')
      throw new StudioError('resume_conflict', 'The workspace changed while stopped. Start a new job to avoid skipping verification.', 409)
    }

    const modelHistory = [...(job.modelHistory ?? []), { model: nextModel, at: now().toISOString(), reason: 'resume' }]
    const resumed = update(jobId, {
      status: 'running',
      step: 'resume',
      model: nextModel,
      modelHistory,
      error: null,
      resume: { count: (job.resume?.count ?? 0) + 1, lastFromStep: job.step, conflict: null },
      verification: null,
    })
    event(jobId, 'job.resumed', `Resuming from ${job.step} with ${nextModel}. Verification will run again.`, {
      fromStep: job.step,
      previousModel: job.model,
      model: nextModel,
      workspaceHash: currentHash,
    }, 'success')
    const controller = new AbortController()
    controllers.set(jobId, controller)
    void execute(resumed, controller, { resume: true, previousJob: job }).finally(() => controllers.delete(jobId))
    return findJobOrThrow(store, jobId)
  }

  function activeCount() {
    return controllers.size
  }

  function isRunning(jobId) {
    return controllers.has(jobId)
  }

  return {
    store,
    start,
    cancel,
    discard,
    approve,
    resume,
    activeCount,
    isRunning,
  }
}

/**
 * Feature mode is opted into by a template that declares `allowedPatterns`.
 * It lets the agent create files inside named trees (scripts, scenes, assets)
 * instead of editing one existing file, which is what "implement this game"
 * needs. Everything else stays exactly as strict as the repair mode.
 */
function isFeatureMode(project) {
  return (project.agent?.allowedPatterns?.length ?? 0) > 0
}

function buildTaskMarkdown({ project, task, model }) {
  if (!isFeatureMode(project)) {
    return [
      `# Task for ${project.name}`,
      '',
      task,
      '',
      '## Editable files',
      ...project.agent.allowedFiles.map((file) => `- ${file}`),
      '',
      '## Hard constraints',
      '- Change only the editable file(s) listed above.',
      '- Do not add, delete, rename or edit any other file, including tests, project settings, scenes, harness files and export presets.',
      '- Keep public names and behavior that existing tests rely on.',
      '- Do not run shell commands or network requests; none are available.',
      `- Model: ${model}`,
      '',
    ].join('\n')
  }

  const patterns = project.agent.allowedPatterns.map((pattern) => `- \`${pattern}\``)
  const protectedPaths = (project.agent.protectedPaths ?? []).map((pattern) => `- \`${pattern}\``)
  return [
    `# Task for ${project.name}`,
    '',
    task,
    '',
    '## What you must produce',
    'This is a real game project, not a description. Implement the requested gameplay',
    'in code and scenes that actually run. A renamed project, a comment, a stub or a',
    'written plan is a failed attempt.',
    '',
    'The project already contains a playable scaffold with a camera, light, floor and',
    'an on-screen hint, plus a read-only acceptance suite that defines the contract.',
    'Read `ARENA_SPEC.md` and `tests/run_arena_tests.gd` before you start. They are',
    'the specification; the game must satisfy their behaviour.',
    '',
    '## Editable paths (modify existing files or add new ones)',
    ...patterns,
    '',
    'Editable files already present:',
    ...project.agent.allowedFiles.map((file) => `- \`${file}\``),
    '',
    '## Read-only paths (never edit, add or delete)',
    ...protectedPaths,
    '',
    '## Hard constraints',
    '- Change or add only files that match the editable paths above.',
    '- Do not delete, rename or move any project file.',
    '- Do not edit tests, the harness bridge, the arena host, `project.godot`, the manifest, `ARENA_SPEC.md` or `README.md`; verification runs a pristine copy of the suite, so editing tests cannot help.',
    '- The running game must satisfy the contract in `ARENA_SPEC.md`. Build nodes in the scene or in code; both are allowed.',
    '- Do not add a `_process()` that calls `tick()`; the read-only host already drives the frame loop.',
    '- Do not call `Input` for gameplay; read the `set_input()` dictionary so real play and tests share one path.',
    '- Do not run shell commands or network requests; none are available.',
    `- Model: ${model}`,
    '',
  ].join('\n')
}

function summarizeSmoke(smoke) {
  if (!smoke) return null
  return {
    available: smoke.available !== false,
    ok: Boolean(smoke.ok),
    skipped: Boolean(smoke.skipped),
    reason: smoke.reason ?? null,
    inputVerified: Boolean(smoke.inputVerified),
    movement: smoke.movement ?? null,
    screenshot: smoke.screenshot ?? null,
    evidence: smoke.evidence ?? null,
  }
}

function verificationFailureLines(verification) {
  const lines = []
  for (const step of verification.steps ?? []) {
    if (step.ok) continue
    if (step.available === false && step.skipped) continue
    lines.push(`${step.label}: ${step.reason ?? step.failures?.join('; ') ?? 'failed'}`)
    for (const failure of step.failures ?? []) lines.push(`  ${failure}`)
  }
  return lines.length > 0 ? lines : ['Verification failed.']
}

/** The first verified failure line from an earlier attempt, if there is one. */
function lastVerifiedFailureLine(job) {
  const failed = [...(job?.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.status === 'verification_failed' && attempt.failure)
  return failed ? String(failed.failure).split('\n')[0] : ''
}

function baselineFailureMessage(baseline) {
  const parts = []
  if (!baseline.check?.ok) parts.push(`Static check: ${baseline.check?.errors?.[0] ?? 'failed'}`)
  for (const entry of baseline.tests ?? []) {
    if (entry.ok) continue
    parts.push(`${entry.label}: ${firstFailures(entry, 3).join('; ') || entry.reason || 'failed'}`)
  }
  return `The untouched baseline did not pass, so no agent was called. ${parts.join(' | ')}`
}

function artifactEntry(store, jobId, relative, contentType) {
  const absolute = path.join(store.paths(jobId).dir, relative)
  return {
    path: relative,
    contentType,
    bytes: fs.statSync(absolute).size,
    sha256: sha256File(absolute),
  }
}

export async function prepareWorkspaceImports({ projectDir, runFixedImpl = runFixed }) {
  const { GODOT_BIN } = await import(
    new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
  )
  const result = await runFixedImpl({
    file: GODOT_BIN,
    args: ['--headless', '--path', projectDir, '--import'],
    cwd: projectDir,
    timeoutMs: 180000,
  })
  const ok = !result.timedOut && (result.code === 0 || result.code === null)
  return {
    ok,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    message: ok
      ? 'Workspace asset import cache prepared.'
      : `Workspace import did not complete cleanly (exit ${result.code}${result.timedOut ? ', timed out' : ''}).`,
  }
}

async function defaultGitCommit({ cwd, runFixed: run }) {
  try {
    const result = await run({
      file: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd,
      timeoutMs: 10000,
    })
    if (result.code === 0) return result.stdout.trim() || null
  } catch {
    // A repository without git still works; the tree hash is the authority.
  }
  return null
}

/**
 * Run one OpenCode attempt with its own private config root. This mirrors the
 * Phase 15/19 adapter arguments but streams stdout so the UI sees progress.
 */
async function defaultAgentRun({
  job,
  project,
  workspace,
  attemptDir,
  attemptNumber,
  model,
  signal,
  onEvent,
  runFixedImpl,
}) {
  const { resolveOpencodeBin, SANDBOX_CONFIG_SOURCE } = await import(
    new URL('../../../experiments/godot-harness/controller/agent-adapter.mjs', import.meta.url)
  )
  const bin = resolveOpencodeBin()
  const configRoot = path.join(attemptDir, 'config')
  const configDir = path.join(configRoot, 'opencode')
  fs.mkdirSync(configDir, { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode.json'))

  const title = `studio ${project.id} attempt ${attemptNumber}`
  const retry = fs.existsSync(path.join(workspace, 'STUDIO_FAILURE.md'))
  const feature = isFeatureMode(project)
  const prompt = retry
    ? feature
      ? 'Read ./STUDIO_FAILURE.md for the verified failure, then fix the game implementation so the acceptance suite passes. Keep the documented API and only touch the editable paths in ./TASK.md. Do not edit tests, the harness, the host or project settings. Do not run shell commands; none are available.'
      : 'Read ./STUDIO_FAILURE.md for the verified failure, then repair the implementation in the allowed file(s) in this project. Keep the public API and do not edit tests or any other file. Do not run shell commands; none are available.'
    : feature
      ? 'Read ./TASK.md and carry out the task exactly: implement the described game in this Godot project, as real scenes and scripts that run. Read ARENA_SPEC.md and tests/run_arena_tests.gd first, then write the implementation. Only edit or add files under the editable paths named in ./TASK.md. Do not edit tests, the harness, the host, project.godot or the manifest. Do not run shell commands; none are available.'
      : 'Read ./TASK.md and carry out the task exactly. Edit only the allowed file(s) named there. Do not edit tests, project settings, harness files or any other file. Do not run shell commands; none are available.'

  const transcript = await runFixedImpl({
    file: bin,
    args: [
      'run',
      '--standalone',
      '--format',
      'json',
      '--auto',
      '--model',
      model,
      '--title',
      title,
      prompt,
    ],
    cwd: workspace,
    env: { ...process.env, XDG_CONFIG_HOME: configRoot },
    timeoutMs: job.limits?.attemptTimeoutMs ?? DEFAULT_LIMITS.attemptTimeoutMs,
    signal,
    onLine: (line, stream) => {
      if (stream !== 'stdout') return
      const parsed = parseTranscriptLine(line)
      if (!parsed) return
      if (parsed.type === 'tool_use') {
        const tool = parsed.part?.tool ?? 'tool'
        const status = parsed.part?.state?.status ?? 'running'
        onEvent('agent.tool', `${tool} · ${status}`, { tool, status })
      } else if (parsed.type === 'text' && parsed.part?.text) {
        onEvent('agent.text', bounded(parsed.part.text, 500))
      } else if (parsed.type === 'step_start') {
        onEvent('agent.step', 'Model step started.', null)
      } else if (parsed.type === 'error') {
        onEvent('agent.error', bounded(parsed.error?.data?.message ?? parsed.error?.name ?? 'Provider error'), parsed, 'error')
      }
    },
  })

  const jobDir = path.dirname(path.dirname(attemptDir))
  const transcriptRelative = path.relative(jobDir, path.join(attemptDir, 'opencode.jsonl')).split(path.sep).join('/')
  const stderrRelative = path.relative(jobDir, path.join(attemptDir, 'opencode.stderr.txt')).split(path.sep).join('/')
  fs.writeFileSync(path.join(attemptDir, 'opencode.jsonl'), transcript.stdout || '', 'utf8')
  fs.writeFileSync(path.join(attemptDir, 'opencode.stderr.txt'), transcript.stderr || '', 'utf8')

  const classification = classifyProviderError({
    code: transcript.code,
    timedOut: transcript.timedOut,
    aborted: transcript.aborted || signal.aborted,
    stderr: transcript.stderr,
    stdout: transcript.stdout,
  })
  return { ...transcript, classification, transcriptRelative, stderrRelative }
}

function parseTranscriptLine(line) {
  if (!line.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

export { DEFAULT_LIMITS, CancelledError, JobStore, isJobId }
