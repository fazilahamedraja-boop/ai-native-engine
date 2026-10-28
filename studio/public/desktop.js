/**
 * AI Game Studio — desktop workspace.
 *
 * One dependency-free client for the existing Studio API. It never invents
 * state: every status, log line, test result, screenshot and approval comes
 * from /api/studio. The only browser storage is UI preference (last project,
 * prompt drafts, recent list) — never job state.
 */

const $ = (selector) => document.querySelector(selector)

const STAGE_ORDER = [
  { id: 'baseline', label: 'Baseline' },
  { id: 'agent', label: 'AI edits' },
  { id: 'verify', label: 'Verification' },
  { id: 'review', label: 'Review & apply' },
]

const STATUS_STYLE = {
  queued: ['Queued', 'pill-idle'],
  running: ['Running', 'pill-running'],
  awaiting_approval: ['Awaiting approval', 'pill-warn'],
  applied: ['Applied', 'pill-ok'],
  discarded: ['Discarded', 'pill-quiet'],
  failed: ['Failed', 'pill-bad'],
  cancelled: ['Cancelled', 'pill-quiet'],
}

const STEP_LABELS = {
  created: 'created',
  imports: 'preparing imports',
  baseline: 'baseline capture',
  agent: 'AI editing',
  resume: 'resuming',
  verify: 'verification',
  awaiting_approval: 'awaiting your approval',
  applied: 'applied',
  discarded: 'discarded',
  cancelled: 'cancelled',
  error: 'error',
}

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const BLOCKING_STATUSES = new Set(['queued', 'running', 'awaiting_approval'])

const state = {
  projects: [],
  jobs: [],
  templates: [],
  meta: null,
  projectId: null,
  project: null,
  jobsForProject: [],
  jobId: null,
  job: null,
  events: [],
  stream: null,
  streamJobId: null,
  jobPollTimer: null,
  workspaceTimer: null,
  jobRefreshTimer: null,
  ops: [],
  captures: [],
  preview: null,
  lastOp: null,
  viewportTab: 'native',
  pane: 'review',
  busy: false,
  opBusy: false,
  creating: false,
  approving: false,
  diff: null,
  diffJobId: null,
  shownCaptureUrl: null,
  draftTimer: null,
  lastTerminalJobId: null,
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') element.className = value
    else if (key === 'text') element.textContent = value
    else if (key === 'dataset') Object.assign(element.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value)
    } else if (key in element && key !== 'list' && key !== 'form') {
      element[key] = value
    } else {
      element.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue
    element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return element
}

function clear(element) {
  while (element.firstChild) element.removeChild(element.firstChild)
}

function setText(selector, text) {
  const element = typeof selector === 'string' ? $(selector) : selector
  if (element) element.textContent = text ?? ''
}

function shortId(value) {
  return typeof value === 'string' ? value.replace(/^(job|op)-/, '').slice(0, 12) : '—'
}

function shortHash(value, length = 10) {
  return typeof value === 'string' && value.length > length ? value.slice(0, length) : (value ?? '—')
}

function timeOfDay(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function dateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function relativeTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`
  return `${Math.round(seconds / 86400)} d ago`
}

function fmtBytes(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return '—'
  if (number < 1024) return `${number} B`
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`
  return `${(number / (1024 * 1024)).toFixed(1)} MB`
}

// Accent colours come from the project registry as hex. The page runs under
// `style-src 'self'`, which blocks style attributes, so instead of writing an
// inline custom property we map the hex to the nearest class in a fixed
// palette. Distinct projects stay visually distinct without weakening the CSP.
const ACCENT_PALETTE = [
  { name: 'amber', hex: '#e0a458' },
  { name: 'mint', hex: '#5cc8a1' },
  { name: 'blue', hex: '#7aa2f7' },
  { name: 'rose', hex: '#ef6b73' },
  { name: 'violet', hex: '#b58ce8' },
  { name: 'cyan', hex: '#5cc9d8' },
]

function accentClass(value, fallback = 'amber') {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(value ?? ''))
  if (!match) return `accent-${fallback}`
  const target = match[1]
  const rgb = [0, 2, 4].map((offset) => parseInt(target.slice(offset, offset + 2), 16))
  let best = ACCENT_PALETTE[0]
  let bestDistance = Infinity
  for (const entry of ACCENT_PALETTE) {
    const hex = entry.hex.slice(1)
    const distance = [0, 2, 4].reduce((total, offset) => {
      const delta = parseInt(hex.slice(offset, offset + 2), 16) - rgb[offset / 2]
      return total + delta * delta
    }, 0)
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry
    }
  }
  return `accent-${best.name}`
}

function statusPill(status) {
  const [label, cls] = STATUS_STYLE[status] ?? [status ?? 'unknown', 'pill-idle']
  return node('span', { class: `pill ${cls}`, text: label })
}

function projectState(project) {
  if (!project.status?.exists) return { label: 'Missing files', cls: 'pill-bad', ready: false }
  if (project.manifestStatus === 'initializing') return { label: 'Initializing', cls: 'pill-running', ready: false }
  if (project.manifestStatus === 'initialization_failed') return { label: 'Setup incomplete', cls: 'pill-warn', ready: false }
  if (project.status.runtime?.running) return { label: `Running · pid ${project.status.runtime.pid ?? '?'}`, cls: 'pill-live', ready: true }
  if (project.status.ready) return { label: 'Ready', cls: 'pill-ok', ready: true }
  return { label: 'Needs import', cls: 'pill-warn', ready: false }
}

function stageState(job) {
  const result = {}
  if (!job) return result
  const status = job.status
  const step = job.step
  const doneAll = status === 'applied'
  const reviewDone = status === 'applied' || status === 'discarded'
  let active = null
  let failed = null

  if (doneAll) {
    for (const stage of STAGE_ORDER) result[stage.id] = 'done'
    return result
  }
  if (reviewDone) {
    result.baseline = 'done'
    result.agent = 'done'
    result.verify = 'done'
    result.review = 'done'
    return result
  }
  if (status === 'awaiting_approval') active = 'review'
  else if (step === 'created' || step === 'imports' || step === 'baseline') active = 'baseline'
  else if (step === 'agent' || step === 'resume') active = 'agent'
  else if (step === 'verify') active = 'verify'
  else if (status === 'failed' || status === 'cancelled') {
    failed = step === 'agent' ? 'agent' : 'verify'
  } else if (status === 'queued') active = 'baseline'

  const activeIndex = STAGE_ORDER.findIndex((stage) => stage.id === active)
  const failedIndex = STAGE_ORDER.findIndex((stage) => stage.id === failed)
  STAGE_ORDER.forEach((stage, index) => {
    if (failed) {
      if (index < failedIndex) result[stage.id] = 'done'
      else if (index === failedIndex) result[stage.id] = 'failed'
    } else if (active) {
      if (index < activeIndex) result[stage.id] = 'done'
      else if (index === activeIndex) result[stage.id] = 'active'
    }
  })
  return result
}

function describeStep(step) {
  const label = step.label ?? step.id ?? 'Step'
  const bits = []
  if (step.summary && (step.summary.passed !== undefined || step.summary.failed !== undefined)) {
    bits.push(`${step.summary.passed ?? 0} passed, ${step.summary.failed ?? 0} failed`)
  }
  if (step.reason && !/tests passed/i.test(step.reason)) bits.push(step.reason)
  if (step.mode) bits.push(`mode: ${step.mode}`)
  if (Number.isFinite(step.durationMs)) bits.push(`${(step.durationMs / 1000).toFixed(1)} s`)
  return bits.length ? `${label} — ${bits.join(' · ')}` : label
}

/* ------------------------------------------------------------------ */
/* API and connection                                                  */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body = null } = {}) {
  const init = { method, headers: {} }
  if (body !== null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(path, init)
  } catch (error) {
    setConnection('bad', 'Backend unreachable')
    const wrapped = new Error(`Cannot reach the Studio backend: ${error.message}`)
    wrapped.code = 'network'
    throw wrapped
  }
  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }
  if (!response.ok) {
    const info = payload?.error ?? {}
    const error = new Error(info.message ?? `Request failed with HTTP ${response.status}.`)
    error.code = info.code ?? `http_${response.status}`
    error.status = response.status
    throw error
  }
  setConnection('live', 'Connected')
  return payload ?? {}
}

function errorText(error) {
  if (!error) return 'Unknown error.'
  return error.code && error.code !== 'network' ? `${error.message} (${error.code})` : error.message
}

function setConnection(kind, text) {
  const pill = $('#connection')
  pill.className = `pill ${kind === 'live' ? 'pill-ok' : kind === 'bad' ? 'pill-bad' : 'pill-idle'}`
  pill.textContent = text
}

function toast(message, kind = 'info') {
  const element = node('div', {
    class: `toast${kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : ''}`,
    role: 'status',
    text: message,
  })
  $('#toasts').append(element)
  setTimeout(() => element.remove(), kind === 'error' ? 8000 : 4500)
}

/* ------------------------------------------------------------------ */
/* Preference storage (UI only)                                        */
/* ------------------------------------------------------------------ */

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`ags:${key}`)
      return raw === null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ags:${key}`, JSON.stringify(value))
    } catch {
      // A full or disabled localStorage must not break the studio.
    }
  },
}

function rememberProject(project) {
  if (!project) return
  const recents = store.get('recent', []).filter((entry) => entry && entry.id !== project.id)
  recents.unshift({ id: project.id, name: project.name, accent: project.accent, at: new Date().toISOString() })
  store.set('recent', recents.slice(0, 6))
  store.set('lastProject', project.id)
}

function promptDraftKey(projectId) {
  return `draft:${projectId}`
}

/* ------------------------------------------------------------------ */
/* Home                                                                */
/* ------------------------------------------------------------------ */

async function loadHomeData({ silent = false } = {}) {
  try {
    const [projectsResponse, jobsResponse] = await Promise.all([
      api('/api/studio/projects'),
      api('/api/studio/jobs'),
    ])
    state.projects = projectsResponse.projects ?? []
    state.jobs = jobsResponse.jobs ?? []
    renderHome()
  } catch (error) {
    setText('#hero-hint', `Could not load projects: ${errorText(error)}`)
    if (!silent) toast(`Projects: ${errorText(error)}`, 'error')
  }
}

function jobsFor(projectId) {
  return state.jobs.filter((job) => job.projectId === projectId)
}

function latestJob(projectId) {
  return jobsFor(projectId)[0] ?? null
}

function renderHome() {
  const created = state.projects.filter((project) => project.created)
  const reference = state.projects.filter((project) => !project.created)

  setText('#stat-projects', String(created.length))
  setText('#stat-jobs', String(state.jobs.length))
  setText(
    '#stat-verified',
    String(state.jobs.filter((job) => job.status === 'applied' && job.verificationOk !== false).length),
  )
  setText('#stat-running', String(state.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length))

  // Recents, filtered against projects that still exist.
  const recents = store.get('recent', []).filter((entry) => state.projects.some((project) => project.id === entry.id))
  const recentList = $('#recent-list')
  clear(recentList)
  if (recents.length === 0) {
    recentList.append(node('span', { class: 'muted small', text: 'Open a project and it will appear here.' }))
  } else {
    for (const entry of recents.slice(0, 5)) {
      const project = state.projects.find((item) => item.id === entry.id)
      recentList.append(
        node('button', {
          type: 'button',
          class: `recent-chip ${accentClass(project?.accent)}`,
          onclick: () => navigateToProject(project.id),
        }, [
          node('span', { class: 'dot' }),
          node('span', { text: entry.name }),
          node('span', { class: 'muted small', text: relativeTime(entry.at) }),
        ]),
      )
    }
  }

  const continueButton = $('#hero-continue')
  const lastId = store.get('lastProject', null)
  const lastProject = state.projects.find((project) => project.id === lastId)
  if (lastProject) {
    continueButton.hidden = false
    setText('#hero-continue-name', lastProject.name)
    continueButton.onclick = () => navigateToProject(lastProject.id)
  } else {
    continueButton.hidden = true
  }

  const grid = $('#project-grid')
  clear(grid)
  for (const project of created) grid.append(projectCard(project, { reference: false }))
  $('#projects-empty').hidden = created.length > 0
  setText('#yours-count', `${created.length} project${created.length === 1 ? '' : 's'}`)

  const referenceGrid = $('#reference-grid')
  clear(referenceGrid)
  for (const project of reference) referenceGrid.append(projectCard(project, { reference: true }))
}

function projectCard(project, { reference = false } = {}) {
  const stateInfo = projectState(project)
  const jobs = jobsFor(project.id)
  const last = jobs[0] ?? null
  const badges = [
    node('span', { class: `pill ${stateInfo.cls}`, text: stateInfo.label }),
    node('span', { class: 'pill pill-quiet', text: project.templateName ?? (reference ? 'Reference' : 'Template') }),
  ]
  if (last) badges.push(statusPill(last.status))
  if (reference) badges.push(node('span', { class: 'pill pill-quiet', text: 'read-only' }))

  const actions = [
    node('button', {
      type: 'button',
      class: 'secondary-button',
      text: 'Open',
      onclick: () => navigateToProject(project.id),
    }),
  ]
  if (!reference && project.agent?.enabled) {
    actions.push(
      node('button', {
        type: 'button',
        class: 'ghost-button',
        text: 'Build with AI',
        onclick: () => {
          navigateToProject(project.id)
          setTimeout(() => $('#prompt')?.focus(), 260)
        },
      }),
    )
  }

  return node('article', {
    class: `project-card ${accentClass(project.accent)}`,
  }, [
    node('div', { class: 'project-card-head' }, [
      node('div', {}, [
        node('h3', { text: project.name }),
        node('span', {
          class: 'template',
          text: project.templateName ?? (reference ? 'Canonical reference' : 'Studio project'),
        }),
      ]),
    ]),
    node('p', { class: 'tagline', text: project.tagline ?? '' }),
    node('div', { class: 'project-meta' }, badges),
    node('p', { class: 'muted small', text: last ? `Last run ${relativeTime(last.createdAt)} · ${jobTaskLine(last)}` : 'No AI runs yet.' }),
    node('div', { class: 'card-actions' }, actions),
  ])
}

function jobTaskLine(job) {
  const text = job.task ?? ''
  return text.length > 64 ? `${text.slice(0, 64)}…` : text
}

function showHome() {
  stopWorkspaceTimers()
  closeStream()
  $('#view-home').hidden = false
  $('#view-workspace').hidden = true
  $('#nav-home').classList.add('is-active')
  $('#nav-workspace').classList.remove('is-active')
  $('#nav-workspace').disabled = !state.projectId
  state.projectId = null
  state.project = null
  state.jobsForProject = []
  state.jobId = null
  state.job = null
  state.events = []
  state.preview = null
  if (location.hash !== '#/' && location.hash !== '') {
    history.replaceState(null, '', '#/')
  }
  loadHomeData()
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '')
  const match = hash.match(/^project\/([a-z0-9-]+)$/)
  return match ? { projectId: match[1] } : null
}

function navigateToProject(projectId) {
  const target = `#/project/${projectId}`
  if (location.hash === target) {
    openProject(projectId)
    return
  }
  location.hash = target
}

function goHome() {
  if (location.hash === '#/' || location.hash === '') {
    showHome()
    return
  }
  location.hash = '#/'
}

async function handleRoute() {
  const route = parseRoute()
  if (!route) {
    showHome()
    return
  }
  await openProject(route.projectId)
}

/* ------------------------------------------------------------------ */
/* Project workspace                                                   */
/* ------------------------------------------------------------------ */

async function openProject(projectId, { preserveJob = false } = {}) {
  try {
    const sameProject = state.projectId === projectId && state.project
    if (!sameProject) {
      closeStream()
      state.projectId = projectId
      state.jobId = null
      state.job = null
      state.events = []
      state.diff = null
      state.captures = []
      state.ops = []
      state.preview = null
      state.shownCaptureUrl = null
      const { project } = await api(`/api/studio/projects/${encodeURIComponent(projectId)}`)
      if (state.projectId !== projectId) return
      state.project = project
      state.jobsForProject = project.jobs ?? []
      rememberProject(project)
      $('#view-home').hidden = true
      $('#view-workspace').hidden = false
      $('#nav-home').classList.remove('is-active')
      $('#nav-workspace').classList.add('is-active')
      $('#nav-workspace').disabled = false
      restoreDraft()
      renderProject()
      renderHistory()
      renderRail()
      renderJob()
      renderEvidence()
      renderPreview()
      selectJob(defaultJobId(project, preserveJob))
      startWorkspaceTimers()
      loadPreview()
      loadOps()
    } else {
      renderProject()
      renderRail()
    }
  } catch (error) {
    toast(`Could not open project: ${errorText(error)}`, 'error')
    if (error.status === 404) goHome()
  }
}

function defaultJobId(project, preserve) {
  if (preserve && state.jobId) return state.jobId
  const jobs = project.jobs ?? []
  return (
    jobs.find((job) => ACTIVE_STATUSES.has(job.status) || job.status === 'awaiting_approval')?.id ??
    jobs[0]?.id ??
    null
  )
}

function renderProject() {
  const project = state.project
  if (!project) return
  setText('#workspace-title', project.name)
  setText(
    '#project-sub',
    [project.templateName ?? 'Reference project', project.path].filter(Boolean).join(' · '),
  )

  const badges = $('#project-badges')
  clear(badges)
  const stateInfo = projectState(project)
  badges.append(node('span', { class: `pill ${stateInfo.cls}`, text: stateInfo.label }))
  if (!project.agent?.enabled) {
    badges.append(node('span', { class: 'pill pill-quiet', text: 'agent disabled' }))
  }
  if (project.runModes?.includes('native')) badges.append(node('span', { class: 'pill pill-quiet', text: 'native' }))
  if (project.browser) badges.append(node('span', { class: 'pill pill-quiet', text: 'browser build' }))
  if (!project.created) badges.append(node('span', { class: 'pill pill-quiet', text: 'reference · read-only' }))

  const agent = project.agent ?? {}
  setText('#composer-model', agent.defaultModel ? `model: ${agent.defaultModel}` : '')
  setText(
    '#agent-note',
    agent.enabled
      ? agent.note ?? 'The agent may only edit the paths registered for this project.'
      : agent.note ?? 'Agent tasks are disabled for this project.',
  )
  const prompt = $('#prompt')
  prompt.disabled = !agent.enabled
  prompt.placeholder = agent.enabled
    ? 'Describe the game or the change you want. For example: build a 3D arena where a blue player fights a red enemy with melee attacks, health bars and a win condition.'
    : 'Agent tasks are disabled for this project. You can still run tests and launch the game.'
  if (!project.created) {
    setText(
      '#agent-note',
      'Reference project: earlier verified work. Runs use an isolated copy, but applying changes here is intentionally disabled in this desktop client.',
    )
  }
  updateBuildAvailability()
}

function updateBuildAvailability() {
  const button = $('#build-game')
  const project = state.project
  const job = state.job
  let reason = ''
  if (!project) reason = 'Open a project first.'
  else if (!project.agent?.enabled) reason = 'Agent tasks are disabled for this project.'
  else if (!project.created) reason = 'Reference projects are read-only in this client.'
  else if (state.busy) reason = 'A request is being started.'
  else if (job && BLOCKING_STATUSES.has(job.status)) {
    reason =
      job.status === 'awaiting_approval'
        ? 'Approve or discard the pending candidate before starting another run.'
        : 'A run is in progress. Cancel it first to start another.'
  }
  button.disabled = Boolean(reason)
  button.title = reason
  const cancel = $('#cancel-job')
  cancel.hidden = !(job && ACTIVE_STATUSES.has(job.status))
}

function restoreDraft() {
  const draft = store.get(promptDraftKey(state.projectId), '')
  $('#prompt').value = draft
  updatePromptCount()
}

function updatePromptCount() {
  const value = $('#prompt').value
  setText('#prompt-count', `${value.length} / 4000`)
}

function saveDraftSoon() {
  clearTimeout(state.draftTimer)
  const projectId = state.projectId
  const value = $('#prompt').value
  state.draftTimer = setTimeout(() => {
    if (projectId) store.set(promptDraftKey(projectId), value)
  }, 350)
}

function showComposerError(message) {
  const element = $('#composer-error')
  element.textContent = message
  element.hidden = !message
}

async function submitBuild() {
  if (!state.project || !state.projectId) return
  const prompt = $('#prompt').value.trim()
  if (prompt.length < 10) {
    showComposerError('Describe the game or change in at least 10 characters.')
    $('#prompt').focus()
    return
  }
  if (prompt.length > 4000) {
    showComposerError('Keep the request under 4000 characters.')
    return
  }
  if (!state.project.agent?.enabled) {
    showComposerError(state.project.agent?.note ?? 'Agent tasks are disabled for this project.')
    return
  }
  if (!state.project.created) {
    showComposerError('Reference projects are read-only in this desktop client.')
    return
  }
  showComposerError('')
  state.busy = true
  const button = $('#build-game')
  button.textContent = 'Starting…'
  updateBuildAvailability()
  try {
    const { job } = await api('/api/studio/jobs', {
      method: 'POST',
      body: { projectId: state.projectId, task: prompt },
    })
    // Show the new run immediately; the detail fetch below replaces the summary.
    if (!state.jobsForProject.some((entry) => entry.id === job.id)) {
      state.jobsForProject.unshift(job)
    }
    renderHistory()
    await refreshProjectQuiet()
    await selectJob(job.id)
    toast('Build started. The AI is editing an isolated workspace.', 'success')
  } catch (error) {
    showComposerError(errorText(error))
    toast(`Build could not start: ${errorText(error)}`, 'error')
  } finally {
    state.busy = false
    button.textContent = 'Build with AI'
    updateBuildAvailability()
  }
}

/* ------------------------------------------------------------------ */
/* Job selection, streaming and rendering                              */
/* ------------------------------------------------------------------ */

function closeStream() {
  if (state.stream) {
    state.stream.close()
    state.stream = null
  }
  state.streamJobId = null
  if (state.jobPollTimer) {
    clearInterval(state.jobPollTimer)
    state.jobPollTimer = null
  }
  if (state.jobRefreshTimer) {
    clearTimeout(state.jobRefreshTimer)
    state.jobRefreshTimer = null
  }
}

async function selectJob(jobId) {
  if (!jobId) {
    state.jobId = null
    state.job = null
    state.events = []
    state.diff = null
    closeStream()
    renderJob()
    renderEvidence()
    return
  }
  const sameJob = state.jobId === jobId && state.job
  state.jobId = jobId
  if (!sameJob) {
    state.job = null
    state.events = []
    state.diff = null
    state.diffJobId = null
    renderJob()
    renderEvidence()
  }
  try {
    const { job, events } = await api(`/api/studio/jobs/${encodeURIComponent(jobId)}`)
    if (state.jobId !== jobId) return
    state.job = job
    mergeEvents(events ?? [], { render: false })
    renderJob()
    renderEvidence()
    renderHistory()
    const terminal = ['applied', 'discarded', 'failed', 'cancelled'].includes(job.status)
    if (terminal || job.status === 'awaiting_approval') {
      closeStream()
      if (terminal) rememberTerminalJob(job)
    } else {
      attachStream(jobId)
    }
  } catch (error) {
    toast(`Run could not load: ${errorText(error)}`, 'error')
  }
}

function rememberTerminalJob(job) {
  if (state.lastTerminalJobId === job.id) return
  state.lastTerminalJobId = job.id
  refreshProjectQuiet()
}

function mergeEvents(incoming, { render = true } = {}) {
  const known = new Set(state.events.map((event) => event.seq))
  let added = false
  for (const event of incoming) {
    if (!event || known.has(event.seq)) continue
    known.add(event.seq)
    state.events.push(event)
    added = true
  }
  if (!added) return
  state.events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  if (state.events.length > 800) state.events = state.events.slice(-800)
  if (render) renderLog()
}

function attachStream(jobId) {
  if (state.stream && state.streamJobId === jobId) return
  closeStream()
  const stream = new EventSource(`/api/studio/jobs/${encodeURIComponent(jobId)}/stream`)
  state.stream = stream
  state.streamJobId = jobId
  stream.addEventListener('open', () => setConnection('live', 'Live'))
  stream.addEventListener('snapshot', (event) => {
    try {
      const data = JSON.parse(event.data)
      if (state.jobId !== jobId) return
      mergeEvents(data.events ?? [])
      scheduleJobRefresh()
    } catch {
      // Ignore a malformed frame; the next one or a poll recovers.
    }
  })
  stream.addEventListener('job-event', (event) => {
    try {
      const parsed = JSON.parse(event.data)
      if (state.jobId !== jobId) return
      mergeEvents([parsed])
      scheduleJobRefresh()
    } catch {
      // Ignore malformed frames.
    }
  })
  stream.addEventListener('error', () => {
    setConnection('bad', 'Reconnecting…')
    scheduleJobRefresh()
  })
  if (state.jobPollTimer) clearInterval(state.jobPollTimer)
  state.jobPollTimer = setInterval(() => {
    if (state.job && ACTIVE_STATUSES.has(state.job.status)) refreshJob()
  }, 6000)
}

function scheduleJobRefresh() {
  if (state.jobRefreshTimer) return
  state.jobRefreshTimer = setTimeout(() => {
    state.jobRefreshTimer = null
    refreshJob()
  }, 320)
}

async function refreshJob() {
  const jobId = state.jobId
  if (!jobId) return
  try {
    const { job, events } = await api(`/api/studio/jobs/${encodeURIComponent(jobId)}`)
    if (state.jobId !== jobId) return
    const previousStatus = state.job?.status
    state.job = job
    mergeEvents(events ?? [], { render: false })
    renderJob()
    renderEvidence()
    renderHistory()
    if (previousStatus !== job.status) {
      updateBuildAvailability()
      refreshProjectQuiet()
    }
    if (['applied', 'discarded', 'failed', 'cancelled', 'awaiting_approval'].includes(job.status)) {
      closeStream()
      if (['applied', 'discarded', 'failed', 'cancelled'].includes(job.status)) rememberTerminalJob(job)
    }
  } catch (error) {
    if (error.status === 404) closeStream()
  }
}

function renderJob() {
  const job = state.job
  const hasJob = Boolean(job)
  $('#job-empty').hidden = hasJob
  $('#job-body').hidden = !hasJob
  updateBuildAvailability()
  if (!hasJob) {
    setText('#job-id', '')
    setText('#history-count', `${state.jobsForProject.length} run${state.jobsForProject.length === 1 ? '' : 's'}`)
    return
  }

  setText('#job-id', `${shortId(job.id)} · ${job.kind ?? 'repair'}`)
  const status = $('#job-status')
  status.className = `pill ${(STATUS_STYLE[job.status] ?? ['unknown', 'pill-idle'])[1]}`
  status.textContent = (STATUS_STYLE[job.status] ?? [job.status])[0]
  setText('#job-step', job.step ? `stage: ${STEP_LABELS[job.step] ?? job.step}` : '')
  setText('#job-updated', `updated ${timeOfDay(job.updatedAt)}`)

  const stages = stageState(job)
  const list = $('#stage-list')
  clear(list)
  for (const stage of STAGE_ORDER) {
    const stageClass = stages[stage.id] ?? ''
    list.append(
      node('li', { class: `stage${stageClass ? ` is-${stageClass}` : ''}` }, [
        node('span', { class: 'dot' }),
        node('span', { text: stage.label }),
      ]),
    )
  }

  setText('#job-task', job.task ?? '')
  const error = $('#job-error')
  if (job.error?.message) {
    const resumable = job.error.resumable ? ' This run can be resumed with another model.' : ''
    error.textContent = `${job.error.message}${resumable}`
    error.hidden = false
  } else {
    error.hidden = true
  }

  renderJobActions(job)
  renderLog()
}

function renderJobActions(job) {
  const actions = $('#job-actions')
  clear(actions)
  const status = job.status
  const isReference = !state.project?.created

  if (ACTIVE_STATUSES.has(status)) {
    actions.append(
      node('button', {
        type: 'button',
        class: 'danger-button',
        text: 'Cancel run',
        onclick: () => cancelJob(job.id),
      }),
    )
  }
  if (status === 'awaiting_approval') {
    if (isReference) {
      actions.append(
        node('span', {
          class: 'muted small',
          text: 'Reference project: the candidate can be inspected but not applied from this client.',
        }),
      )
    } else {
      actions.append(
        node('button', {
          type: 'button',
          class: 'primary-button',
          text: 'Approve and apply…',
          onclick: () => openApproveDialog(job),
        }),
        node('button', {
          type: 'button',
          class: 'danger-button',
          text: 'Discard candidate',
          onclick: () => discardJob(job.id),
        }),
      )
    }
    actions.append(
      node('button', {
        type: 'button',
        class: 'ghost-button',
        text: 'View diff',
        onclick: () => {
          switchPane('files')
          loadDiff(job.id)
        },
      }),
    )
  }
  if (status === 'applied') {
    actions.append(
      node('span', {
        class: 'pill pill-ok',
        text: `applied ${dateTime(job.approval?.approvedAt ?? job.updatedAt)}`,
      }),
      node('button', {
        type: 'button',
        class: 'ghost-button',
        text: 'Start another improvement',
        onclick: () => {
          // The applied prompt described the previous change; start the next
          // improvement from a clean box instead of resubmitting it by accident.
          const prompt = $('#prompt')
          prompt.value = ''
          prompt.dispatchEvent(new Event('input', { bubbles: true }))
          prompt.focus()
        },
      }),
    )
  }
  if (status === 'discarded') {
    actions.append(
      node('span', { class: 'muted small', text: 'Candidate discarded. Project files are unchanged.' }),
    )
  }
  if (status === 'failed' || status === 'cancelled') {
    if (!isReference) {
      actions.append(
        node('button', {
          type: 'button',
          class: 'secondary-button',
          text: 'Resume run',
          onclick: () => resumeJob(job.id),
        }),
      )
    }
    actions.append(
      node('button', {
        type: 'button',
        class: 'ghost-button',
        text: 'Edit request and retry',
        onclick: () => {
          if (job.task) {
            $('#prompt').value = job.task
            updatePromptCount()
            saveDraftSoon()
          }
          $('#prompt').focus()
        },
      }),
    )
  }
}

function renderLog() {
  const log = $('#log')
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
  clear(log)
  if (state.events.length === 0) {
    log.append(
      node('p', {
        class: 'log-empty',
        text: state.job ? 'Waiting for the first event…' : 'Select a run to see its log.',
      }),
    )
    $('#log-jump').hidden = true
    return
  }
  for (const event of state.events) {
    log.append(
      node('div', { class: `log-row level-${event.level ?? 'info'}` }, [
        node('span', { class: 't', text: timeOfDay(event.at) }),
        node('span', { class: 'k', text: event.type ?? 'event', title: event.type ?? '' }),
        node('span', { class: 'm', text: event.message ?? '' }),
      ]),
    )
  }
  if (nearBottom) {
    log.scrollTop = log.scrollHeight
    $('#log-jump').hidden = true
  } else {
    $('#log-jump').hidden = false
  }
}

function renderHistory() {
  const list = $('#history-list')
  clear(list)
  const jobs = state.jobsForProject
  setText('#history-count', `${jobs.length} run${jobs.length === 1 ? '' : 's'}`)
  if (jobs.length === 0) {
    list.append(node('p', { class: 'muted small', text: 'No generation runs yet for this project.' }))
    return
  }
  for (const job of jobs) {
    list.append(
      node('button', {
        type: 'button',
        class: `history-row${job.id === state.jobId ? ' is-active' : ''}`,
        title: job.task ?? '',
        onclick: () => selectJob(job.id),
      }, [
        statusPill(job.status),
        node('span', { class: 'history-task', text: job.task ?? '(no request recorded)' }),
        node('span', {
          class: 'history-meta',
          text: `${dateTime(job.createdAt)} · ${job.changedFiles ?? 0} file${job.changedFiles === 1 ? '' : 's'}`,
        }),
      ]),
    )
  }
}

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

function renderRail() {
  const list = $('#rail-list')
  clear(list)
  const created = state.projects.filter((project) => project.created)
  const reference = state.projects.filter((project) => !project.created)
  const addGroup = (label, projects) => {
    if (projects.length === 0) return
    list.append(node('div', { class: 'rail-section', text: label }))
    for (const project of projects) {
      list.append(
        node('button', {
          type: 'button',
          class: `rail-item ${accentClass(project.accent)}${project.id === state.projectId ? ' is-active' : ''}`,
          title: project.name,
          onclick: () => navigateToProject(project.id),
        }, [
          node('span', { class: 'rail-dot' }),
          node('span', { class: 'rail-label', text: project.name }),
        ]),
      )
    }
  }
  addGroup('Your projects', created)
  addGroup('Reference', reference)
}

/* ------------------------------------------------------------------ */
/* Evidence: verification, approval, files, shots, attempts            */
/* ------------------------------------------------------------------ */

function renderEvidence() {
  renderVerification()
  renderApproval()
  renderChangedFiles()
  renderGallery()
  renderAttempts()
  renderOps()
}

function verificationModel(job) {
  const verified = []
  const unverified = []
  if (!job) {
    return { state: 'pending', title: 'No run selected', verified, unverified: ['Select a generation run to review its evidence.'] }
  }
  if (!job.verification) {
    if (job.status === 'failed' || job.status === 'cancelled') {
      return {
        state: 'unverified',
        title: job.status === 'cancelled' ? 'Run cancelled' : 'Run failed before verification',
        verified,
        unverified: [job.error?.message ?? 'No verification report was produced.'],
      }
    }
    return {
      state: 'pending',
      title: 'Verification pending',
      verified,
      unverified: ['The candidate has not been verified yet. Approval is impossible in this state.'],
    }
  }
  for (const step of job.verification.steps ?? []) {
    if (step.available === false) {
      unverified.push(`${step.label ?? step.id}: not available${step.reason ? ` — ${step.reason}` : ''}`)
      continue
    }
    if (step.ok) verified.push(describeStep(step))
    else unverified.push(describeStep(step))
  }
  if (job.verification.ok) {
    unverified.push(
      'Behavior outside the recorded suites and probes (audio, settings menus, long sessions, other hardware) is not verified.',
    )
  }
  if (job.status === 'awaiting_approval') {
    unverified.push('The candidate has not been applied to the project; you have not approved it yet.')
  }
  if (job.status === 'discarded') {
    unverified.push('The candidate was discarded. The project still contains its previous files.')
  }
  const stateName = job.verification.ok
    ? job.status === 'awaiting_approval'
      ? 'pending'
      : 'verified'
    : 'unverified'
  const title =
    job.status === 'applied'
      ? 'Applied — verified candidate'
      : job.status === 'awaiting_approval'
        ? 'Verified — awaiting your approval'
        : job.status === 'discarded'
          ? 'Verified candidate was discarded'
          : job.verification.ok
            ? 'Verified candidate'
            : 'Verification failed'
  return { state: stateName, title, verified, unverified }
}

function renderVerification() {
  const container = $('#review-summary')
  clear(container)
  const model = verificationModel(state.job)
  container.className = `summary-card ${model.state === 'verified' ? 'is-verified' : model.state === 'unverified' ? 'is-unverified' : 'is-pending'}`
  container.append(
    node('div', { class: 'summary-title' }, [
      node('span', {
        class: `pill ${model.state === 'verified' ? 'pill-ok' : model.state === 'unverified' ? 'pill-bad' : 'pill-idle'}`,
        text: model.state === 'verified' ? 'verified' : model.state === 'unverified' ? 'not verified' : 'pending',
      }),
      node('span', { text: model.title }),
    ]),
  )
  if (model.verified.length > 0) {
    container.append(
      node('h3', { class: 'summary-sub', text: 'Verified' }),
      node('ul', { class: 'summary-list' }, model.verified.map((line) => node('li', { text: line }))),
    )
  }
  if (model.unverified.length > 0) {
    container.append(
      node('h3', { class: 'summary-sub', text: 'Not verified' }),
      node('ul', { class: 'summary-list' }, model.unverified.map((line) => node('li', { text: line }))),
    )
  }

  const steps = $('#verify-steps')
  clear(steps)
  const job = state.job
  if (!job?.verification) {
    steps.append(
      node('p', {
        class: 'muted small',
        text: 'Verification runs after the AI edits and the file-policy check. It imports the candidate, checks scripts, runs the public and pristine suites, and probes real input.',
      }),
    )
    setText('#verify-note', '')
    return
  }
  for (const step of job.verification.steps ?? []) {
    const skipped = step.available === false
    const failed = step.ok === false && !skipped
    const failureLines = (entry) =>
      typeof entry === 'string'
        ? entry
        : `${entry?.name ?? 'failure'}${entry?.detail ? ` — ${entry.detail}` : ''}`
    steps.append(
      node('div', { class: `verify-step${failed ? ' fail' : skipped ? ' skip' : ''}` }, [
        node('div', { class: 'verify-step-head' }, [
          node('strong', { text: step.label ?? step.id ?? 'Step' }),
          node('span', {
            class: `pill ${failed ? 'pill-bad' : skipped ? 'pill-warn' : 'pill-ok'}`,
            text: skipped ? 'skipped' : step.ok ? 'pass' : 'fail',
          }),
        ]),
        step.summary
          ? node('p', { text: `${step.summary.passed ?? 0} passed · ${step.summary.failed ?? 0} failed` })
          : null,
        step.reason ? node('p', { text: step.reason }) : null,
        step.mode ? node('p', { text: `mode: ${step.mode}` }) : null,
        // Only a failing step lists diagnostics: passing suites still record the
        // harness's summary line, which would read as a spurious failure here.
        ...(failed ? (step.errors ?? []).slice(0, 5).map((entry) => node('p', { text: failureLines(entry) })) : []),
        ...(failed ? (step.failures ?? []).slice(0, 5).map((entry) => node('p', { text: failureLines(entry) })) : []),
      ]),
    )
  }
  setText(
    '#verify-note',
    job.verification.ok
      ? `Recorded ${dateTime(job.verification.verifiedAt)}. A candidate is only applied after your explicit approval.`
      : `Recorded ${dateTime(job.verification.verifiedAt)}. A failed candidate cannot be approved.`,
  )
}

function renderApproval() {
  const box = $('#approval-box')
  clear(box)
  const job = state.job
  if (!job) return
  if (job.status === 'awaiting_approval') {
    box.append(
      node('p', {
        class: 'approval-note',
        text: `Approval writes ${job.changedFiles?.length ?? 0} file(s) into the project. The server re-checks the candidate hash before writing.`,
      }),
      node('div', { class: 'approval-actions' }, [
        node('button', {
          type: 'button',
          class: 'primary-button',
          text: 'Approve and apply…',
          disabled: !state.project?.created,
          title: state.project?.created ? '' : 'Reference projects are read-only in this client.',
          onclick: () => openApproveDialog(job),
        }),
        node('button', {
          type: 'button',
          class: 'danger-button',
          text: 'Discard',
          disabled: !state.project?.created,
          onclick: () => discardJob(job.id),
        }),
      ]),
    )
  } else if (job.status === 'applied') {
    const applied = job.approval?.appliedFiles ?? []
    box.append(
      node('p', {
        class: 'approval-note',
        text: `Applied ${dateTime(job.approval?.approvedAt ?? job.updatedAt)} · ${applied.length} file(s) · candidate ${shortHash(job.approval?.candidateHash ?? job.candidateHash)}`,
      }),
      node('ul', { class: 'summary-list' }, applied.map((entry) =>
        node('li', { text: `${entry.file} — ${fmtBytes(entry.bytes)}` }),
      )),
    )
  } else if (job.status === 'discarded') {
    box.append(node('p', { class: 'approval-note', text: 'This candidate was discarded; no project files were written.' }))
  } else if (ACTIVE_STATUSES.has(job.status)) {
    box.append(node('p', { class: 'approval-note', text: 'Approval controls unlock only after verification finishes.' }))
  } else if (job.status === 'failed') {
    box.append(node('p', { class: 'approval-note', text: 'No candidate can be approved from a failed run.' }))
  } else if (job.status === 'cancelled') {
    box.append(node('p', { class: 'approval-note', text: 'The run was cancelled before approval. Resume it to continue where it stopped.' }))
  }
}

function renderChangedFiles() {
  const container = $('#changed-files')
  clear(container)
  const job = state.job
  const changed = job?.changedFiles ?? []
  setText('#changed-count', changed.length ? `${changed.length} file(s)` : 'none')
  setText('#diff-view', '')
  $('#diff-view').hidden = true
  setText('#load-diff', 'Show diff')
  if (changed.length === 0) {
    container.append(node('p', { class: 'muted small', text: 'No candidate files have been recorded yet.' }))
    return
  }
  const table = node('table', { class: 'files-table' }, [
    node('thead', {}, [
      node('tr', {}, [
        node('th', { text: 'File' }),
        node('th', { text: 'Status' }),
        node('th', { text: 'Size' }),
        node('th', { text: 'After hash' }),
      ]),
    ]),
    node('tbody', {}, changed.map((entry) =>
      node('tr', {}, [
        node('td', { class: 'path', text: entry.file }),
        node('td', { text: entry.status }),
        node('td', { text: `${fmtBytes(entry.beforeBytes)} → ${fmtBytes(entry.afterBytes)}` }),
        node('td', { class: 'path', text: shortHash(entry.afterSha256) }),
      ]),
    )),
  ])
  container.append(table)
}

async function loadDiff(jobId) {
  if (!jobId) return
  const pre = $('#diff-view')
  if (state.diffJobId === jobId && state.diff) {
    pre.hidden = !pre.hidden
    setText('#load-diff', pre.hidden ? 'Show diff' : 'Hide diff')
    return
  }
  if (!state.job?.artifacts?.diff) {
    toast('This run recorded no diff artifact.', 'error')
    return
  }
  try {
    const response = await fetch(`/api/studio/jobs/${encodeURIComponent(jobId)}/diff`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const text = await response.text()
    state.diff = text
    state.diffJobId = jobId
    pre.textContent = text
    pre.hidden = false
    setText('#load-diff', 'Hide diff')
  } catch (error) {
    toast(`Diff unavailable: ${error.message}`, 'error')
  }
}

function artifactUrl(job, relativePath) {
  const encoded = String(relativePath).split('/').map(encodeURIComponent).join('/')
  return `/api/studio/jobs/${encodeURIComponent(job.id)}/artifacts/${encoded}`
}

function renderGallery() {
  const container = $('#job-gallery')
  clear(container)
  const job = state.job
  const artifacts = job?.artifacts ?? {}
  const images = ['before', 'after'].filter((key) => artifacts[key])
  if (!job || images.length === 0) {
    container.append(
      node('p', {
        class: 'muted small',
        text: job ? 'No before/after captures were recorded for this run.' : 'Select a run to see its evidence.',
      }),
    )
  } else {
    for (const key of images) {
      container.append(
        node('figure', { class: 'shot' }, [
          node('img', {
            src: artifactUrl(job, artifacts[key].path),
            alt: `${key === 'before' ? 'Before' : 'After'} capture from ${job.projectName}`,
            loading: 'lazy',
          }),
          node('figcaption', {
            text: `${key === 'before' ? 'Before' : 'After'} · captured ${dateTime(artifacts[key].capturedAt ?? job.createdAt)}`,
          }),
        ]),
      )
    }
  }
  const textArtifacts = Object.entries(artifacts).filter(([, value]) => !['before.png', 'after.png'].includes(String(value.path).split('/').pop()))
  if (job && textArtifacts.length) {
    const links = node('div', { class: 'stack' })
    for (const [key, artifact] of textArtifacts) {
      links.append(
        node('a', {
          href: artifactUrl(job, artifact.path),
          target: '_blank',
          rel: 'noopener',
          class: 'muted small',
          text: `${key} artifact · ${fmtBytes(artifact.bytes)}`,
        }),
      )
    }
    container.append(links)
  }
}

function renderAttempts() {
  const container = $('#attempts-list')
  clear(container)
  const job = state.job
  if (!job) {
    container.append(node('p', { class: 'muted small', text: 'Select a run to see AI attempts.' }))
    return
  }
  const attempts = job.attempts ?? []
  if (attempts.length === 0) {
    container.append(
      node('p', {
        class: 'muted small',
        text: 'No AI attempt is recorded yet. Attempts appear as soon as the agent starts.',
      }),
    )
    return
  }
  for (const attempt of attempts) {
    const summary = attempt.agent?.summary ?? {}
    const tools = summary.tools ?? {}
    const toolText = Object.entries(tools)
      .map(([name, info]) => `${name} ${info?.completed ?? 0}`)
      .join(' · ')
    container.append(
      node('div', { class: 'attempt' }, [
        node('div', { class: 'attempt-head' }, [
          node('strong', { text: `Attempt ${attempt.attempt ?? '?'}` }),
          node('span', {
            class: `pill ${attempt.status === 'passed' ? 'pill-ok' : attempt.status === 'failed' ? 'pill-bad' : 'pill-idle'}`,
            text: attempt.status ?? 'unknown',
          }),
          node('span', { class: 'muted small', text: attempt.model ?? '' }),
          node('span', {
            class: 'muted small push-right',
            text: Number.isFinite(attempt.agent?.durationMs)
              ? `${Math.round(attempt.agent.durationMs / 1000)} s`
              : '',
          }),
        ]),
        summary.lastText ? node('p', { text: summary.lastText }) : null,
        toolText ? node('p', { class: 'muted small', text: `Tools: ${toolText}` }) : null,
        attempt.agent?.classification?.message
          ? node('p', { class: 'small', text: attempt.agent.classification.message })
          : null,
        node('details', {}, [
          node('summary', { text: 'Attempt details' }),
          node('pre', {
            text: JSON.stringify(
              {
                attempt: attempt.attempt,
                status: attempt.status,
                startedAt: attempt.startedAt,
                model: attempt.model,
                events: summary.events ?? null,
                durationMs: attempt.agent?.durationMs ?? null,
                classification: attempt.agent?.classification ?? null,
                transcript: attempt.agent?.transcript ?? null,
                stderr: attempt.agent?.stderr ?? null,
              },
              null,
              2,
            ),
          }),
        ]),
      ]),
    )
  }
}

/* ------------------------------------------------------------------ */
/* Operations and preview                                              */
/* ------------------------------------------------------------------ */

async function loadOps() {
  if (!state.projectId) return
  try {
    const { ops } = await api(`/api/studio/ops?projectId=${encodeURIComponent(state.projectId)}&limit=60`)
    state.ops = ops ?? []
    harvestCaptures()
    renderOps()
    renderCaptures()
  } catch (error) {
    setText('#op-result', `Operations unavailable: ${errorText(error)}`)
  }
}

function harvestCaptures() {
  const seen = new Set(state.captures.map((entry) => entry.url))
  const additions = []
  for (const record of state.ops) {
    const artifact = record.artifact
    if (!artifact?.url || seen.has(artifact.url)) continue
    seen.add(artifact.url)
    additions.push({
      url: artifact.url,
      label: record.summary ?? record.op,
      op: record.op,
      at: record.startedAt,
      bytes: artifact.bytes,
      width: record.result?.frame?.width ?? null,
      height: record.result?.frame?.height ?? null,
    })
  }
  state.captures = [...additions, ...state.captures].slice(0, 24)
}

function renderOps() {
  const list = $('#op-history')
  clear(list)
  if (state.ops.length === 0) {
    list.append(node('p', { class: 'muted small', text: 'No test, launch or capture operations yet.' }))
    return
  }
  for (const record of state.ops.slice(0, 14)) {
    list.append(
      node('button', {
        type: 'button',
        class: 'op-row',
        title: record.summary ?? '',
        onclick: () => {
          state.lastOp = record
          renderOpResult(record)
        },
      }, [
        node('span', {
          class: `pill ${record.status === 'ok' ? 'pill-ok' : record.status === 'running' ? 'pill-running' : 'pill-bad'}`,
          text: record.status,
        }),
        node('span', { class: 'op-name', text: record.op }),
        node('span', { class: 'op-summary', text: record.summary ?? '' }),
        node('span', { class: 'muted small', text: timeOfDay(record.startedAt) }),
      ]),
    )
  }
}

function renderCaptures() {
  const container = $('#capture-gallery')
  clear(container)
  setText('#capture-count', `${state.captures.length} frame${state.captures.length === 1 ? '' : 's'}`)
  if (state.captures.length === 0) {
    container.append(
      node('p', {
        class: 'muted small',
        text: 'No native captures yet. Launch the game, then use Capture frame.',
      }),
    )
    return
  }
  for (const entry of state.captures.slice(0, 8)) {
    container.append(
      node('figure', { class: 'shot' }, [
        node('img', { src: entry.url, alt: `Native capture: ${entry.label}`, loading: 'lazy' }),
        node('figcaption', {
          text: `${entry.width && entry.height ? `${entry.width}×${entry.height} · ` : ''}${dateTime(entry.at)} · captured frame`,
        }),
      ]),
    )
  }
}

function renderOpResult(record) {
  const container = $('#op-result')
  clear(container)
  if (!record) return
  container.append(
    node('p', {}, [
      node('strong', { text: `${record.op} · ${record.status}` }),
      node('span', { class: 'muted small', text: ` ${record.durationMs ?? 0} ms · ${dateTime(record.startedAt)}` }),
    ]),
    node('p', { text: record.summary ?? '' }),
  )
  if (record.error?.message) container.append(node('p', { class: 'inline-error', text: record.error.message }))
  const logs = record.logs ?? {}
  const stderr = (logs.stderr ?? []).slice(-4)
  if (stderr.length) {
    container.append(node('pre', { class: 'diff', text: stderr.join('\n') }))
  }
}

async function loadPreview() {
  if (!state.projectId) return
  try {
    state.preview = await api(`/api/studio/projects/${encodeURIComponent(state.projectId)}/preview`)
    renderPreview()
  } catch (error) {
    state.preview = null
    renderPreview()
    setText('#native-hint', `Preview unavailable: ${errorText(error)}`)
  }
}

function renderPreview() {
  renderNativePanel()
  renderBrowserPanel()
}

function renderNativePanel() {
  const preview = state.preview
  const native = preview?.native ?? { running: false }
  const running = Boolean(native.running)
  setText('#native-state', running ? `running · pid ${native.pid ?? '?'} · ${relativeTime(native.startedAt)}` : 'not running')

  const mode = $('#native-mode')
  const latest = state.captures[0] ?? null
  if (running) {
    mode.className = 'pill pill-live'
    mode.textContent = 'external native window · running'
  } else if (latest) {
    mode.className = 'pill pill-warn'
    mode.textContent = 'captured frame · not live'
  } else {
    mode.className = 'pill pill-warn'
    mode.textContent = 'external native window'
  }

  const frame = $('#native-frame')
  if (latest) {
    if (state.shownCaptureUrl !== latest.url) {
      clear(frame)
      frame.append(
        node('img', { src: latest.url, alt: 'Captured frame from the native Godot window' }),
        node('span', {
          class: 'frame-caption',
          text: `Captured frame — not live · ${dateTime(latest.at)}${latest.width ? ` · ${latest.width}×${latest.height}` : ''}`,
        }),
      )
      state.shownCaptureUrl = latest.url
    }
  } else {
    state.shownCaptureUrl = null
    clear(frame)
    frame.append(
      node('div', { class: 'frame-placeholder' }, [
        node('p', {}, [node('strong', { text: running ? 'The game window is open on your desktop.' : 'No live video is possible for a native Godot window.' })]),
        node('p', {
          text: running
            ? 'This panel cannot mirror a native window in real time. Use Capture frame to take a real screenshot through the harness bridge.'
            : 'Launch the game to open its real window, then capture a frame. Captures are always labelled as captured — never as live gameplay.',
        }),
      ]),
    )
  }

  const launch = $('#native-launch')
  const stop = $('#native-stop')
  const capture = $('#native-capture')
  const busy = state.opBusy
  launch.disabled = busy || running
  stop.disabled = busy || !running
  capture.disabled = busy || !running
  $('#native-relaunch').disabled = busy
  $('#native-check').disabled = busy
  $('#native-logs').disabled = busy
  const suite = state.project?.tests?.[0] ?? null
  const test = $('#native-test')
  test.disabled = busy || !suite
  test.title = suite ? `Run ${suite.label}` : 'No test suite is registered for this project.'
  test.textContent = suite ? 'Run test suite' : 'No test suite'

  if (!preview) {
    setText('#native-hint', 'Preview status is unavailable right now.')
  } else if (running) {
    setText('#native-hint', 'The native window is a separate OS window. This client can stop it and capture real frames, but cannot embed it.')
  } else if (latest) {
    setText('#native-hint', `Showing the last captured frame (${dateTime(latest.at)}). It is not live.`)
  } else {
    setText('#native-hint', 'Launching starts a real Godot process and opens its own window.')
  }
}

function renderBrowserPanel() {
  const preview = state.preview
  const browser = preview?.browser ?? null
  const frame = $('#browser-frame')
  const stateLabel = $('#browser-state')
  const mode = $('#browser-mode')
  const note = $('#browser-note')
  const open = $('#browser-open')

  if (!browser?.configured) {
    mode.className = 'pill pill-idle'
    mode.textContent = 'no browser build'
    stateLabel.textContent = 'not registered'
    clear(frame)
    frame.append(
      node('div', { class: 'frame-placeholder' }, [
        node('p', {}, [node('strong', { text: 'This project has no browser build.' })]),
        node('p', {
          text: 'Created projects run in the native Godot window. A per-project web export is not part of this build, so no fake frame is shown here.',
        }),
      ]),
    )
    open.disabled = true
    note.textContent = browser?.label ?? ''
    return
  }

  open.disabled = !browser.reachable
  if (browser.reachable) {
    mode.className = 'pill pill-live'
    mode.textContent = 'live · embedded browser build'
    stateLabel.textContent = `reachable · HTTP ${browser.status ?? 200}`
    const mounted = frame.querySelector('iframe')
    if (!mounted || mounted.getAttribute('src') !== browser.url) {
      clear(frame)
      frame.append(
        node('iframe', {
          src: browser.url,
          title: `${state.project?.name ?? 'Project'} browser build`,
          allow: 'fullscreen; gamepad; pointer-lock',
        }),
      )
    }
    note.textContent = `${browser.label}. This is the registered canonical browser build, not the agent candidate.`
  } else {
    mode.className = 'pill pill-warn'
    mode.textContent = 'browser build unreachable'
    stateLabel.textContent = 'not reachable'
    clear(frame)
    frame.append(
      node('div', { class: 'frame-placeholder' }, [
        node('p', {}, [node('strong', { text: 'The registered browser build is not answering.' })]),
        node('p', { text: browser.error ?? `No response from ${browser.url}.` }),
        node('p', {
          text: 'Start the canonical loopback build outside the Studio (the Studio will not run an arbitrary web process), then recheck. The frame is never fabricated.',
        }),
      ]),
    )
    note.textContent = `Registered URL: ${browser.url}`
  }
}

function setViewportTab(tab) {
  state.viewportTab = tab
  const nativeSelected = tab === 'native'
  $('#tab-native').classList.toggle('is-active', nativeSelected)
  $('#tab-native').setAttribute('aria-selected', String(nativeSelected))
  $('#tab-browser').classList.toggle('is-active', !nativeSelected)
  $('#tab-browser').setAttribute('aria-selected', String(!nativeSelected))
  $('#viewport-native').hidden = !nativeSelected
  $('#viewport-browser').hidden = nativeSelected
  if (!nativeSelected && state.preview) renderBrowserPanel()
}

function switchPane(pane) {
  state.pane = pane
  for (const tab of document.querySelectorAll('.inspector-tabs .tab')) {
    const active = tab.dataset.pane === pane
    tab.classList.toggle('is-active', active)
    tab.setAttribute('aria-selected', String(active))
  }
  $('#pane-review').hidden = pane !== 'review'
  $('#pane-files').hidden = pane !== 'files'
  $('#pane-shots').hidden = pane !== 'shots'
  $('#pane-attempts').hidden = pane !== 'attempts'
}

async function runOp(op, args = {}, { silent = false } = {}) {
  if (!state.projectId || state.opBusy) return null
  state.opBusy = true
  renderNativePanel()
  setText('#op-result', `Running ${op}…`)
  try {
    const { op: record } = await api('/api/studio/ops', {
      method: 'POST',
      body: { projectId: state.projectId, op, args },
    })
    state.lastOp = record
    renderOpResult(record)
    if (!silent) toast(record.summary ?? `${op} finished.`, record.status === 'ok' ? 'success' : 'error')
    if (op === 'capture') setViewportTab('native')
    await Promise.all([loadOps(), loadPreview(), refreshProjectQuiet()])
    return record
  } catch (error) {
    setText('#op-result', `${op} failed: ${errorText(error)}`)
    toast(`${op} failed: ${errorText(error)}`, 'error')
    return null
  } finally {
    state.opBusy = false
    renderNativePanel()
  }
}

async function launchGame() {
  const record = await runOp('launch', {})
  if (record) loadPreview()
}

async function relaunchGame() {
  if (state.opBusy) return
  if (state.preview?.native?.running) {
    await runOp('stop', {}, { silent: true })
  }
  await runOp('launch', {})
  await loadPreview()
}

async function captureFrame() {
  const record = await runOp('capture', {})
  if (record) {
    switchPane('shots')
    setViewportTab('native')
    renderNativePanel()
  }
}

/* ------------------------------------------------------------------ */
/* Job actions                                                         */
/* ------------------------------------------------------------------ */

async function cancelJob(jobId) {
  try {
    await api(`/api/studio/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
    toast('Cancelling the run…', 'info')
    await refreshJob()
    await refreshProjectQuiet()
  } catch (error) {
    toast(`Cancel failed: ${errorText(error)}`, 'error')
  }
}

async function resumeJob(jobId) {
  const model = state.job?.model ?? state.project?.agent?.defaultModel
  try {
    await api(`/api/studio/jobs/${encodeURIComponent(jobId)}/resume`, {
      method: 'POST',
      body: { model },
    })
    toast('Run resumed with the configured model.', 'success')
    await refreshProjectQuiet()
    await selectJob(jobId)
  } catch (error) {
    toast(`Resume failed: ${errorText(error)}`, 'error')
  }
}

async function discardJob(jobId) {
  const confirmed = window.confirm(
    'Discard this verified candidate?\n\nThe project files will not change. The evidence stays available in the run history.',
  )
  if (!confirmed) return
  try {
    await api(`/api/studio/jobs/${encodeURIComponent(jobId)}/discard`, { method: 'POST' })
    toast('Candidate discarded. No files were written.', 'success')
    await refreshJob()
    await refreshProjectQuiet()
  } catch (error) {
    toast(`Discard failed: ${errorText(error)}`, 'error')
  }
}

function openApproveDialog(job) {
  if (!job || job.status !== 'awaiting_approval' || !state.project?.created) return
  const dialog = $('#approve-dialog')
  const files = $('#approve-files')
  clear(files)
  for (const entry of job.changedFiles ?? []) {
    files.append(
      node('div', {
        text: `${entry.file} · ${fmtBytes(entry.beforeBytes)} → ${fmtBytes(entry.afterBytes)} · ${shortHash(entry.afterSha256)}`,
      }),
    )
  }
  $('#approve-error').hidden = true
  $('#approve-confirm').disabled = false
  $('#approve-confirm').textContent = 'Approve and apply'
  dialog.showModal()
  $('#approve-confirm').focus()
}

async function confirmApprove() {
  const job = state.job
  if (!job || state.approving) return
  state.approving = true
  const button = $('#approve-confirm')
  const errorBox = $('#approve-error')
  button.disabled = true
  button.textContent = 'Applying…'
  errorBox.hidden = true
  try {
    await api(`/api/studio/jobs/${encodeURIComponent(job.id)}/approve`, { method: 'POST' })
    $('#approve-dialog').close()
    toast('Candidate applied. The project files were updated.', 'success')
    await refreshJob()
    await refreshProjectQuiet()
    await loadOps()
  } catch (error) {
    errorBox.textContent = errorText(error)
    errorBox.hidden = false
  } finally {
    state.approving = false
    button.disabled = false
    button.textContent = 'Approve and apply'
  }
}

/* ------------------------------------------------------------------ */
/* Create project                                                      */
/* ------------------------------------------------------------------ */

async function loadTemplates() {
  if (state.templates.length > 0) return state.templates
  const { templates } = await api('/api/studio/templates')
  state.templates = (templates ?? []).filter((template) => template.implemented)
  return state.templates
}

function suggestedName(templateId) {
  const base = templateId === 'voxel-sandbox' ? 'Block World' : 'Arena Game'
  const taken = new Set(state.projects.map((project) => project.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index < 99; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${Date.now()}`
}

async function openCreateDialog({ templateId = 'arena' } = {}) {
  const dialog = $('#create-dialog')
  $('#create-error').hidden = true
  $('#create-error').textContent = ''
  try {
    const templates = await loadTemplates()
    const select = $('#create-template')
    clear(select)
    for (const template of templates) {
      select.append(
        node('option', { value: template.id, text: template.label ?? template.name }),
      )
    }
    select.value = templates.some((template) => template.id === templateId)
      ? templateId
      : templates[0]?.id ?? 'arena'
    updateTemplateDescription()
    const nameInput = $('#create-name')
    nameInput.value = suggestedName(select.value)
    $('#create-prompt').value = ''
    updateCreatePromptCount()
    setCreateBusy(false)
    dialog.showModal()
    nameInput.focus()
    nameInput.select()
  } catch (error) {
    toast(`Templates could not load: ${errorText(error)}`, 'error')
  }
}

function updateTemplateDescription() {
  const selected = state.templates.find((template) => template.id === $('#create-template').value)
  setText('#template-description', selected?.description ?? '')
}

function updateCreatePromptCount() {
  const length = $('#create-prompt').value.length
  setText(
    '#create-prompt-count',
    `${length} / 4000 · ${length >= 10 ? 'a build will start immediately' : 'leave empty to create the project without starting a run'}`,
  )
  const button = $('#create-submit')
  button.textContent = length >= 10 ? 'Create & build' : 'Create project'
}

function setCreateBusy(busy) {
  state.creating = busy
  $('#create-submit').disabled = busy
  $('#create-name').disabled = busy
  $('#create-template').disabled = busy
  $('#create-prompt').disabled = busy
  $('#create-cancel').disabled = busy
  $('#create-submit').textContent = busy
    ? 'Creating… preparing Godot imports'
    : $('#create-prompt').value.length >= 10
      ? 'Create & build'
      : 'Create project'
}

function showCreateError(message) {
  const box = $('#create-error')
  box.textContent = message
  box.hidden = !message
}

async function submitCreate(event) {
  event.preventDefault()
  if (state.creating) return
  const name = $('#create-name').value.trim()
  const templateId = $('#create-template').value
  const prompt = $('#create-prompt').value.trim()
  if (name.length < 2) {
    showCreateError('Give the project a name of at least 2 characters.')
    $('#create-name').focus()
    return
  }
  if (prompt.length > 0 && prompt.length < 10) {
    showCreateError('Describe the game in at least 10 characters, or leave the description empty.')
    $('#create-prompt').focus()
    return
  }
  showCreateError('')
  setCreateBusy(true)
  try {
    if (prompt.length >= 10) {
      const { project, job } = await api('/api/studio/build-game', {
        method: 'POST',
        body: { name, templateId, prompt },
      })
      $('#create-dialog').close()
      await loadHomeData({ silent: true })
      navigateToProject(project.id)
      toast('Project created. The build is starting.', 'success')
      await waitForWorkspace(project.id)
      if (job?.id) await selectJob(job.id)
    } else {
      const { project } = await api('/api/studio/projects', {
        method: 'POST',
        body: { name, templateId },
      })
      $('#create-dialog').close()
      await loadHomeData({ silent: true })
      navigateToProject(project.id)
      toast('Project created and imported.', 'success')
    }
  } catch (error) {
    showCreateError(errorText(error))
    if (error.code === 'project_exists') {
      $('#create-name').focus()
      $('#create-name').select()
    }
  } finally {
    setCreateBusy(false)
  }
}

async function waitForWorkspace(projectId, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (state.projectId === projectId && state.project) return true
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Workspace timers and quiet refresh                                  */
/* ------------------------------------------------------------------ */

function startWorkspaceTimers() {
  stopWorkspaceTimers()
  state.workspaceTimer = setInterval(async () => {
    if (document.hidden || !state.projectId) return
    await loadPreview()
    await refreshProjectQuiet()
  }, 9000)
}

function stopWorkspaceTimers() {
  if (state.workspaceTimer) {
    clearInterval(state.workspaceTimer)
    state.workspaceTimer = null
  }
}

async function refreshProjectQuiet() {
  if (!state.projectId) return
  try {
    const { project } = await api(`/api/studio/projects/${encodeURIComponent(state.projectId)}`)
    if (state.projectId !== project.id) return
    state.project = project
    state.jobsForProject = project.jobs ?? []
    state.projects = state.projects.map((entry) => (entry.id === project.id ? { ...entry, ...project } : entry))
    renderProject()
    renderHistory()
    renderRail()
    if (state.jobId) {
      // Keep the selected job row's summary fresh without discarding live events.
      const summary = state.jobsForProject.find((entry) => entry.id === state.jobId)
      if (summary && state.job) {
        state.job = { ...state.job, status: summary.status, step: summary.step, updatedAt: summary.updatedAt }
        renderJob()
      }
    }
  } catch {
    // A transient refresh failure must not erase the workspace; the next poll retries.
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function wire() {
  $('#nav-home').addEventListener('click', goHome)
  $('#nav-workspace').addEventListener('click', () => {
    if (state.projectId) navigateToProject(state.projectId)
  })
  $('#open-evidence').addEventListener('click', () => {
    const url = new URL('/', location.href).href
    if (window.studioDesktop?.openExternal) {
      window.studioDesktop.openExternal(url)
    } else {
      window.open(url, '_blank', 'noopener')
    }
  })

  $('#hero-new').addEventListener('click', () => openCreateDialog())
  $('#empty-create').addEventListener('click', () => openCreateDialog())
  $('#hero-refresh').addEventListener('click', () => loadHomeData())
  $('#rail-home').addEventListener('click', goHome)

  $('#create-form').addEventListener('submit', submitCreate)
  $('#create-close').addEventListener('click', () => $('#create-dialog').close())
  $('#create-cancel').addEventListener('click', () => $('#create-dialog').close())
  $('#create-template').addEventListener('change', () => {
    updateTemplateDescription()
    const nameInput = $('#create-name')
    if (!nameInput.value.trim() || state.templates.some((template) => suggestedName(template.id) === nameInput.value)) {
      nameInput.value = suggestedName($('#create-template').value)
    }
  })
  $('#create-prompt').addEventListener('input', updateCreatePromptCount)
  $('#create-dialog').addEventListener('click', (event) => {
    if (event.target === $('#create-dialog')) $('#create-dialog').close()
  })

  $('#prompt').addEventListener('input', () => {
    updatePromptCount()
    saveDraftSoon()
    showComposerError('')
  })
  $('#prompt').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      submitBuild()
    }
  })
  $('#build-game').addEventListener('click', submitBuild)
  $('#cancel-job').addEventListener('click', () => {
    if (state.jobId) cancelJob(state.jobId)
  })
  $('#log-jump').addEventListener('click', () => {
    const log = $('#log')
    log.scrollTop = log.scrollHeight
    $('#log-jump').hidden = true
  })

  $('#native-launch').addEventListener('click', launchGame)
  $('#native-stop').addEventListener('click', () => runOp('stop'))
  $('#native-relaunch').addEventListener('click', relaunchGame)
  $('#native-capture').addEventListener('click', captureFrame)
  $('#native-check').addEventListener('click', () => runOp('check'))
  $('#native-test').addEventListener('click', () => {
    const suite = state.project?.tests?.[0]
    if (suite) runOp('test', { testId: suite.id })
  })
  $('#native-logs').addEventListener('click', () => {
    runOp('logs').then((record) => {
      if (record?.logs) {
        const lines = [...(record.logs.stdout ?? []), ...(record.logs.stderr ?? [])]
        if (lines.length === 0) {
          setText('#op-result', `${record.summary} No output lines were recorded.`)
        }
      }
    })
  })

  $('#tab-native').addEventListener('click', () => setViewportTab('native'))
  $('#tab-browser').addEventListener('click', () => setViewportTab('browser'))
  $('#browser-recheck').addEventListener('click', () => loadPreview())
  $('#browser-open').addEventListener('click', () => {
    const url = state.preview?.browser?.url
    if (!url) return
    if (window.studioDesktop?.openExternal) window.studioDesktop.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  })

  for (const tab of document.querySelectorAll('.inspector-tabs .tab')) {
    tab.addEventListener('click', () => switchPane(tab.dataset.pane))
  }
  $('#inspector-refresh').addEventListener('click', async () => {
    await Promise.all([refreshProjectQuiet(), loadOps(), loadPreview()])
    if (state.jobId) await refreshJob()
    toast('Evidence refreshed.', 'info')
  })
  $('#load-diff').addEventListener('click', () => loadDiff(state.jobId))

  $('#approve-close').addEventListener('click', () => $('#approve-dialog').close())
  $('#approve-cancel').addEventListener('click', () => $('#approve-dialog').close())
  $('#approve-confirm').addEventListener('click', confirmApprove)
  $('#approve-dialog').addEventListener('click', (event) => {
    if (event.target === $('#approve-dialog')) $('#approve-dialog').close()
  })

  window.addEventListener('hashchange', () => {
    handleRoute()
  })
  window.addEventListener('focus', () => {
    if (state.projectId) {
      loadPreview()
      refreshProjectQuiet()
    }
  })
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.projectId) {
      loadPreview()
      refreshProjectQuiet()
    }
  })
}

function applyRuntimeMode() {
  const desktop = window.studioDesktop
  const chip = $('#runtime-mode')
  if (desktop) {
    chip.textContent = 'Desktop'
    chip.title = `AI Game Studio ${desktop.version ?? ''} · ${desktop.mode === 'attached' ? 'attached server' : 'in-process server'}`
    setText(
      '#brand-sub',
      `v${desktop.version ?? '0.1.0'} · desktop · isolated agents · real verification`,
    )
  } else {
    chip.textContent = 'Browser preview'
    chip.title = 'This page is served by the Studio backend in a browser; launch the desktop app for the full experience.'
  }
}

async function boot() {
  applyRuntimeMode()
  wire()
  setConnection('idle', 'Connecting…')
  try {
    state.meta = await api('/api/studio/meta')
    setConnection('live', 'Connected')
  } catch (error) {
    setConnection('bad', 'Backend unreachable')
    setText('#hero-hint', `Could not reach the Studio backend: ${errorText(error)}`)
    toast(`Backend unavailable: ${errorText(error)}`, 'error')
    return
  }
  await loadHomeData()
  const route = parseRoute()
  if (route) await openProject(route.projectId)
  else showHome()
}

boot()
