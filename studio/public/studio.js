'use strict'

/**
 * Studio workspace.
 *
 * Plain DOM, no framework. Untrusted text (task, model output, logs, file
 * names) is always written with textContent, never innerHTML.
 */

const $ = (selector, root = document) => root.querySelector(selector)
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector))

const STATUSES = new Set([
  'queued',
  'running',
  'awaiting_approval',
  'applied',
  'discarded',
  'failed',
  'cancelled',
  'corrupted',
])

const state = {
  meta: null,
  templates: [],
  projects: [],
  projectId: null,
  project: null,
  jobs: [],
  jobId: null,
  job: null,
  events: [],
  ops: [],
  lastOp: null,
  gallery: [],
  preview: null,
  stream: null,
  activeTab: 'task',
  busyOp: false,
  diffCache: new Map(),
  refreshTimer: null,
  pollTimer: null,
}

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue
    if (key === 'class') element.className = value
    else if (key === 'text') element.textContent = value
    else if (key === 'dataset') Object.assign(element.dataset, value)
    else if (key === 'attrs') {
      for (const [name, attrValue] of Object.entries(value)) {
        if (attrValue !== null && attrValue !== undefined) element.setAttribute(name, attrValue)
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2), value)
    } else if (key in element) {
      element[key] = value
    } else {
      element.setAttribute(key, value)
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue
    element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return element
}

function clear(element) {
  element.replaceChildren()
}

function shortHash(value, length = 12) {
  if (!value || typeof value !== 'string') return '—'
  return value.slice(0, length)
}

function shortId(value) {
  if (typeof value !== 'string') return '—'
  const parts = value.split('-')
  return parts.length > 3 ? `${parts[0]}-${parts.slice(-2).join('-')}` : value
}

function timeOfDay(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function dateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

async function api(path, { method = 'GET', body = null } = {}) {
  const init = { method, headers: {} }
  if (body !== null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetch(path, init)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message ?? `Request failed with HTTP ${response.status}.`)
    error.code = payload?.error?.code ?? 'http_error'
    error.status = response.status
    throw error
  }
  return payload
}

function setConnection(kind, text) {
  const element = $('#connection')
  element.className = `conn conn-${kind}`
  element.textContent = text
}

function showNotice(message, { error = false, warning = false } = {}) {
  const notice = $('#notice')
  if (!message) {
    notice.hidden = true
    clear(notice)
    return
  }
  notice.hidden = false
  notice.className = `notice${error ? ' notice-error' : warning ? ' notice-warn' : ''}`
  clear(notice)
  notice.append(node('span', { text: message }))
}

function showJobError(job) {
  const banner = $('#job-error')
  clear(banner)
  if (!job?.error) {
    banner.hidden = true
    return
  }
  banner.hidden = false
  banner.append(
    node('strong', { text: `${job.error.class ?? 'Error'} · ${job.error.message ?? ''}` }),
  )
  if (job.error.requiresModelSwitch) {
    banner.append(
      node('p', {
        class: 'small',
        text: 'This failure is terminal for the current provider/model. Choose a different model below before resuming — the server refuses to retry the same one.',
      }),
    )
  }
  if (job.error.resumable === false) {
    banner.append(node('p', { class: 'small', text: 'This failure cannot be resumed safely. Start a new job.' }))
  }
}

function statusClass(status) {
  return STATUSES.has(status) ? `pill pill-${status}` : 'pill'
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

function renderProjects() {
  const list = $('#project-list')
  clear(list)
  for (const project of state.projects) {
    const runtime = project.status?.runtime ?? { running: false }
    const ready = Boolean(project.status?.ready)
    const dotClass = ready ? 'dot dot-ok' : 'dot dot-off'
    const agentBadge = project.agent?.enabled
      ? node('span', { class: 'badge badge-ok', text: 'agent' })
      : node('span', { class: 'badge badge-off', text: 'read-only' })
    const item = node(
      'li',
      {
        class: `project-item${project.id === state.projectId ? ' is-active' : ''}`,
        dataset: { project: project.id },
      },
      [
        node('button', { type: 'button', onclick: () => selectProject(project.id) }, [
          node('span', { class: 'project-item-name' }, [
            node('span', { class: dotClass, attrs: { 'aria-hidden': 'true' } }),
            project.name,
          ]),
          node('p', { class: 'project-item-tagline', text: project.tagline }),
          node('span', { class: 'project-item-foot' }, [
            ...(project.runModes ?? []).map((mode) =>
              node('span', { class: 'badge badge-quiet', text: mode }),
            ),
            runtime.running ? node('span', { class: 'badge badge-ok', text: 'live' }) : null,
            project.created ? node('span', { class: 'badge badge-new', text: 'created' }) : null,
            agentBadge,
          ]),
        ]),
      ],
    )
    list.append(item)
  }
}

function applyProject() {
  const project = state.project
  if (!project) return
  const main = $('#main')
  main.dataset.project = project.id
  $('#project-name').textContent = project.name
  $('#project-tagline').textContent = project.tagline
  $('#project-path').textContent = project.path
  $('#project-modes').textContent = (project.runModes ?? []).join(' · ')
  const editablePaths = project.agent?.enabled
    ? [...(project.agent.allowedFiles ?? []), ...(project.agent.allowedPatterns ?? [])].join(', ')
    : ''
  $('#project-agent').textContent = project.agent?.enabled
    ? `enabled · ${editablePaths}`
    : 'disabled'
  $('#project-tests').textContent = (project.tests ?? []).map((test) => test.label).join(' · ') || '—'
  $('#project-origin').textContent = project.created
    ? `${project.templateName ?? 'Unknown template'} · created ${dateTime(project.createdAt)}`
    : 'Built-in reference project'

  const enabled = Boolean(project.agent?.enabled)
  const badge = $('#agent-badge')
  badge.textContent = enabled ? 'agent enabled' : 'agent disabled'
  badge.className = `badge ${enabled ? 'badge-ok' : 'badge-off'}`
  $('#agent-note').textContent = project.agent?.note ?? ''
  $('#allowed-files').textContent = enabled ? editablePaths : 'No editable files are allowed.'
  $('#composer-limit').textContent = enabled
    ? `Bounded run: ${project.agent.maxAttempts} attempt(s), then human approval. The canonical project is never edited by the agent.`
    : 'Agent changes are disabled for this project. Tests, launch and inspection stay available.'

  const textarea = $('#task-input')
  const submit = $('#submit-task')
  textarea.disabled = !enabled
  submit.disabled = !enabled
  if (!enabled) {
    textarea.placeholder = 'Agent tasks are disabled for this project.'
  } else {
    textarea.placeholder =
      'Example: make the voxel boundary check safely reject a chunk id outside the world, without changing the public API.'
  }

  const modelSelect = $('#model-select')
  const previous = modelSelect.value
  clear(modelSelect)
  const models = state.meta?.models ?? []
  for (const model of models) {
    modelSelect.append(node('option', { value: model, text: model }))
  }
  const preferred = project.agent?.defaultModel
  modelSelect.value = models.includes(previous) ? previous : models.includes(preferred) ? preferred : models[0] ?? ''
  modelSelect.disabled = !enabled || models.length === 0

  const testSelect = $('#test-select')
  clear(testSelect)
  for (const suite of project.tests ?? []) {
    testSelect.append(node('option', { value: suite.id, text: suite.label }))
  }
  testSelect.disabled = (project.tests ?? []).length === 0

  renderControls()
  renderOps()
  renderJobs()
}

function renderControls() {
  const container = $('#controls-list')
  clear(container)
  const controls = state.project?.controls ?? { movement: [], actions: [] }
  for (const key of controls.movement ?? []) {
    container.append(node('span', { class: 'control-key', text: key }))
  }
  for (const action of controls.actions ?? []) {
    container.append(node('span', { class: 'control-key', text: action.label ?? action.name }))
  }
  if ((controls.movement ?? []).length === 0 && (controls.actions ?? []).length === 0) {
    container.append(node('span', { class: 'muted small', text: 'No controls are registered for this project.' }))
  }
}

async function selectProject(projectId, { keepJob = false } = {}) {
  if (state.stream) {
    state.stream.close()
    state.stream = null
  }
  state.projectId = projectId
  state.project = null
  state.jobs = []
  if (!keepJob) {
    state.jobId = null
    state.job = null
    state.events = []
  }
  state.ops = []
  state.lastOp = null
  state.gallery = []
  state.preview = null
  showNotice('')
  renderProjects()
  try {
    const { project } = await api(`/api/studio/projects/${encodeURIComponent(projectId)}`)
    state.project = project
    state.jobs = project.jobs ?? []
    applyProject()
    renderJob()
    await Promise.allSettled([loadOps(), loadPreview()])
    if (state.jobId) await loadJob(state.jobId)
  } catch (error) {
    showNotice(`Could not load ${projectId}: ${error.message}`, { error: true })
  }
}

async function loadProjects() {
  const { projects } = await api('/api/studio/projects')
  state.projects = projects
  renderProjects()
  return projects
}

/* ------------------------------------------------------------------ */
/* Create project                                                      */
/* ------------------------------------------------------------------ */

const CREATE_ERROR_LABELS = {
  invalid_project_name: 'That name cannot be used',
  invalid_template: 'Unsupported template',
  invalid_description: 'Description too long',
  project_exists: 'Name already in use',
  project_limit: 'Project limit reached',
  corrupted_project: 'A project directory is corrupted',
  template_missing: 'Template unavailable',
}

function suggestedProjectName() {
  const base = 'My Block World'
  const taken = new Set(state.projects.map((project) => String(project.name).toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base
}

function setCreateError(message = '', code = '') {
  const box = $('#create-error')
  clear(box)
  if (!message) {
    box.hidden = true
    return
  }
  box.hidden = false
  if (code) box.append(node('strong', { text: `${code} · ` }))
  box.append(node('span', { text: message }))
}

function closeCreateDialog() {
  const dialog = $('#create-dialog')
  if (dialog.open && typeof dialog.close === 'function') dialog.close()
  else dialog.removeAttribute('open')
}

async function openCreateDialog() {
  setCreateError('')
  $('#create-name').value = suggestedProjectName()
  $('#create-description').value = ''

  const select = $('#create-template')
  clear(select)
  const submit = $('#create-submit')
  submit.textContent = 'Create project'
  try {
    const { templates } = await api('/api/studio/templates')
    state.templates = templates
  } catch {
    state.templates = state.meta?.templates ?? []
  }

  const implemented = state.templates.filter((template) => template.implemented !== false)
  if (implemented.length === 0) {
    select.append(node('option', { value: '', text: 'No templates are installed' }))
    $('#create-template-help').textContent =
      'No template is available on this machine, so a new project cannot be created right now.'
    submit.disabled = true
  } else {
    for (const template of state.templates) {
      select.append(
        node('option', {
          value: template.id,
          text: template.label ?? template.name,
          disabled: template.implemented === false,
        }),
      )
    }
    select.value = implemented[0].id
    $('#create-template-help').textContent =
      implemented.length === 1
        ? `This is the only implemented template. It copies the ${implemented[0].name} project into a new isolated directory; no other game type exists yet.`
        : implemented.map((template) => template.name).join(', ')
    submit.disabled = false
  }

  const dialog = $('#create-dialog')
  if (typeof dialog.showModal === 'function') dialog.showModal()
  else dialog.setAttribute('open', '')
  const nameInput = $('#create-name')
  nameInput.focus()
  nameInput.select()
}

async function submitCreate(event) {
  event.preventDefault()
  setCreateError('')

  const name = $('#create-name').value.trim()
  const templateId = $('#create-template').value
  const description = $('#create-description').value.trim()

  if (name.length < 2) {
    setCreateError('Give the project a name of 2–48 characters.')
    $('#create-name').focus()
    return
  }
  if (!templateId) {
    setCreateError('Choose a template. No template is installed on this machine.')
    return
  }

  const submit = $('#create-submit')
  submit.disabled = true
  submit.textContent = 'Creating…'
  try {
    const { project } = await api('/api/studio/projects', {
      method: 'POST',
      body: { name, templateId, description },
    })
    closeCreateDialog()
    await loadProjects()
    await selectProject(project.id)
    switchTab('preview')
    const ready = project.manifestStatus === 'ready'
    showNotice(
      ready
        ? `Created "${project.name}" from the ${project.templateName ?? templateId} template at ${project.path}. ` +
            'The template was imported, so Launch can start it now.'
        : `Created "${project.name}" at ${project.path}, but Godot could not finish importing the template: ` +
            `${project.initialization?.message ?? 'unknown import error'} ` +
            'The project is kept; launching will fail until the import succeeds.',
      { warning: !ready },
    )
  } catch (error) {
    setCreateError(error.message, CREATE_ERROR_LABELS[error.code] ?? error.code ?? 'error')
    if (error.code === 'project_exists') {
      $('#create-name').focus()
      $('#create-name').select()
    }
  } finally {
    submit.disabled = false
    submit.textContent = 'Create project'
  }
}

/* ------------------------------------------------------------------ */
/* Build Game with AI                                                  */
/* ------------------------------------------------------------------ */

const DEMO_BUILD_PROMPT =
  'Create a small 3D arena action game. Add a controllable player, a visible enemy, player attacks, enemy health, player health, and a win or loss condition. Make the arena visually readable and ensure the controls are explained on screen.'

const BUILD_ERROR_LABELS = {
  invalid_prompt: 'Description too short',
  invalid_project_name: 'That name cannot be used',
  project_exists: 'Name already in use',
  project_limit: 'Project limit reached',
  template_missing: 'Template unavailable',
  unknown_template: 'Unsupported template',
  agent_disabled: 'Agent unavailable',
  model_not_allowed: 'Model not allowed',
  invalid_model: 'Unsupported model',
}

function suggestedBuildName() {
  const base = 'Arena Action'
  const taken = new Set(state.projects.map((project) => String(project.name).toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let index = 2; index < 200; index += 1) {
    const candidate = `${base} ${index}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return base
}

function setBuildError(message = '', code = '') {
  const box = $('#build-error')
  clear(box)
  if (!message) {
    box.hidden = true
    return
  }
  box.hidden = false
  if (code) box.append(node('strong', { text: `${code} · ` }))
  box.append(node('span', { text: message }))
}

function initBuildForm() {
  const prompt = $('#build-prompt')
  if (!prompt.value.trim()) prompt.value = DEMO_BUILD_PROMPT
  const name = $('#build-name')
  if (!name.value.trim()) name.value = suggestedBuildName()

  const select = $('#build-model')
  const previous = select.value
  clear(select)
  const models = state.meta?.models ?? []
  for (const model of models) select.append(node('option', { value: model, text: model }))
  const preferred = 'opencode/deepseek-v4.1-flash-free'
  select.value = models.includes(previous) ? previous : models.includes(preferred) ? preferred : models[0] ?? ''
  select.disabled = models.length === 0
  $('#build-submit').disabled = models.length === 0
  $('#build-limit').textContent =
    models.length === 0
      ? 'No model is configured, so a build cannot start. Set STUDIO_AGENT_MODELS on the server.'
      : 'The agent may edit the new project only; tests, the harness and project settings stay read-only.'
}

async function submitBuild(event) {
  event.preventDefault()
  setBuildError('')

  const name = $('#build-name').value.trim()
  const prompt = $('#build-prompt').value.trim()
  const model = $('#build-model').value

  if (name.length < 2) {
    setBuildError('Give the project a name of 2–48 characters.', 'invalid_project_name')
    $('#build-name').focus()
    return
  }
  if (prompt.length < 10) {
    setBuildError('Describe the game in at least 10 characters.', 'invalid_prompt')
    $('#build-prompt').focus()
    return
  }
  if (!model) {
    setBuildError('No model is configured on the server.', 'agent_disabled')
    return
  }

  const submit = $('#build-submit')
  submit.disabled = true
  submit.textContent = 'Creating project…'
  showNotice('Creating an isolated project from the arena template, then starting the agent…')
  try {
    const { project, job } = await api('/api/studio/build-game', {
      method: 'POST',
      body: { name, prompt, model },
    })
    await loadProjects()
    await selectProject(project.id)
    switchTab('task')
    await loadJob(job.id)
    initBuildForm()
    showNotice(
      `Created "${project.name}" at ${project.path}. The build job is ${job.status}; ` +
        'watch the timeline, then verify and approve the result here.',
      { warning: project.manifestStatus !== 'ready' },
    )
  } catch (error) {
    setBuildError(error.message, BUILD_ERROR_LABELS[error.code] ?? error.code ?? 'error')
    showNotice(`Could not start the build: ${error.message}`, { error: true })
  } finally {
    submit.textContent = 'Build game'
    submit.disabled = (state.meta?.models ?? []).length === 0
  }
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

function renderJobs() {
  const list = $('#jobs-list')
  clear(list)
  if (!state.jobs.length) {
    list.append(node('p', { class: 'muted', text: 'No jobs have been started for this project yet.' }))
    return
  }
  for (const job of state.jobs) {
    const row = node('div', { class: 'job-row' }, [
      node(
        'button',
        {
          type: 'button',
          onclick: () => {
            switchTab('task')
            loadJob(job.id)
          },
        },
        [
          node('span', { class: 'job-row-task', text: job.task ?? '(no task recorded)' }),
          node('span', {
            class: 'job-row-meta',
            text: `${shortId(job.id)} · ${job.model ?? '—'} · ${dateTime(job.createdAt)} · ${job.attemptCount ?? 0} attempt(s)`,
          }),
        ],
      ),
      node('span', { class: statusClass(job.status), text: job.status ?? 'unknown' }),
    ])
    list.append(row)
  }
}

async function refreshJobs() {
  const { jobs } = await api(`/api/studio/jobs?projectId=${encodeURIComponent(state.projectId)}`)
  state.jobs = jobs
  renderJobs()
}

async function loadJob(jobId) {
  if (!jobId) return
  state.jobId = jobId
  try {
    const { job, events } = await api(`/api/studio/jobs/${encodeURIComponent(jobId)}`)
    state.job = job
    state.events = events
    renderJob()
    attachStream(jobId)
    history.replaceState(null, '', `#job=${encodeURIComponent(jobId)}`)
    $('#job-detail').hidden = false
    $('#job-empty').hidden = true
  } catch (error) {
    showNotice(`Could not load job ${jobId}: ${error.message}`, { error: true })
  }
}

async function refreshJob() {
  if (!state.jobId) return
  try {
    const { job, events } = await api(`/api/studio/jobs/${encodeURIComponent(state.jobId)}`)
    state.job = job
    state.events = events
    renderJob()
    if (['applied', 'discarded', 'failed', 'cancelled'].includes(job.status)) {
      await refreshJobs()
    }
  } catch {
    // The SSE stream will retry; a transient refresh failure is not fatal.
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) return
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null
    refreshJob()
  }, 320)
}

function attachStream(jobId) {
  if (state.stream) state.stream.close()
  if (state.pollTimer) {
    clearInterval(state.pollTimer)
    state.pollTimer = null
  }
  const stream = new EventSource(`/api/studio/jobs/${encodeURIComponent(jobId)}/stream`)
  state.stream = stream
  stream.addEventListener('open', () => setConnection('live', 'Live'))
  stream.addEventListener('snapshot', (event) => {
    try {
      const data = JSON.parse(event.data)
      if (data.job?.id === state.jobId) scheduleRefresh()
    } catch {
      // Ignore malformed frames.
    }
  })
  stream.addEventListener('job-event', (event) => {
    try {
      const parsed = JSON.parse(event.data)
      if (state.events.some((entry) => entry.seq === parsed.seq)) return
      state.events.push(parsed)
      renderEvents()
      scheduleRefresh()
    } catch {
      // Ignore malformed frames.
    }
  })
  stream.addEventListener('error', () => setConnection('error', 'Reconnecting…'))
  state.pollTimer = setInterval(() => {
    if (state.job && ['queued', 'running'].includes(state.job.status)) refreshJob()
  }, 5000)
}

function renderJob() {
  const job = state.job
  if (!job) {
    $('#job-detail').hidden = true
    $('#job-empty').hidden = false
    return
  }
  $('#job-detail').hidden = false
  $('#job-empty').hidden = true

  const status = $('#job-status')
  status.className = statusClass(job.status)
  status.textContent = job.status ?? 'unknown'
  $('#job-title').textContent = `${job.projectName ?? job.projectId ?? 'Project'} · ${shortId(job.id)}`
  $('#job-task').textContent = job.task ?? '(no task recorded)'
  $('#job-step').textContent = job.step ? `step: ${job.step}` : ''

  const meta = $('#job-meta')
  clear(meta)
  const entries = [
    ['Job', shortId(job.id)],
    ['Model', job.model ?? '—'],
    ['Created', dateTime(job.createdAt)],
    ['Updated', dateTime(job.updatedAt)],
    ['Start commit', job.startCommit ? shortHash(job.startCommit) : '—'],
    ['Baseline hash', shortHash(job.baselineHash)],
    ['Candidate hash', shortHash(job.candidateHash)],
    ['Attempts', String(job.attempts?.length ?? 0)],
  ]
  for (const [label, value] of entries) {
    meta.append(node('div', {}, [node('dt', { text: label }), node('dd', { text: value })]))
  }

  showJobError(job)
  renderActions(job)
  renderVerification(job)
  renderChangedFiles(job)
  renderJobGallery(job)
  renderAttempts(job)
  renderEvents()

  if (job.status !== 'awaiting_approval') {
    $('#diff-view').hidden = true
  }
}

function renderActions(job) {
  const container = $('#job-actions')
  clear(container)
  const status = job.status

  if (status === 'queued' || status === 'running') {
    container.append(
      node('button', {
        class: 'button button-danger',
        type: 'button',
        text: 'Cancel job',
        onclick: () => jobAction(job.id, 'cancel'),
      }),
    )
  }

  if (status === 'awaiting_approval') {
    const verified = Boolean(job.verification?.ok)
    container.append(
      node('button', {
        class: 'button button-primary',
        type: 'button',
        text: verified ? 'Approve & apply' : 'Approve (blocked: not verified)',
        disabled: !verified,
        title: verified
          ? 'Re-check the workspace hash, then copy only the allowed files back.'
          : 'Verification did not pass; approval is refused.',
        onclick: () => jobAction(job.id, 'approve'),
      }),
      node('button', {
        class: 'button button-danger',
        type: 'button',
        text: 'Discard workspace',
        onclick: () => jobAction(job.id, 'discard'),
      }),
    )
    return
  }

  if (status === 'failed' || status === 'cancelled') {
    const models = (state.meta?.models ?? []).filter((model) => model !== job.model)
    const select = node(
      'select',
      { class: 'model-select', attrs: { 'aria-label': 'Model for resume' }, id: 'resume-model' },
      models.length
        ? models.map((model) => node('option', { value: model, text: model }))
        : [node('option', { value: '', text: 'No alternative model configured' })],
    )
    container.append(select)
    container.append(
      node('button', {
        class: 'button',
        type: 'button',
        text: 'Resume',
        disabled: models.length === 0 || Boolean(job.resume?.conflict),
        title: job.resume?.conflict
          ? 'The workspace hash changed; resume is refused to avoid skipping verification.'
          : 'Resume from the preserved workspace and re-run verification.',
        onclick: () => {
          const model = $('#resume-model')?.value
          if (!model) {
            showNotice('No alternative model is configured. Set STUDIO_AGENT_MODELS and restart the Studio.', {
              error: true,
            })
            return
          }
          jobAction(job.id, 'resume', { model })
        },
      }),
    )
    container.append(
      node('button', {
        class: 'button button-danger',
        type: 'button',
        text: 'Discard workspace',
        onclick: () => jobAction(job.id, 'discard'),
      }),
    )
  }
}

async function jobAction(jobId, action, body = null) {
  const labels = { cancel: 'Cancelling…', discard: 'Discarding…', approve: 'Approving…', resume: 'Resuming…' }
  showNotice(labels[action] ?? 'Working…')
  try {
    await api(`/api/studio/jobs/${encodeURIComponent(jobId)}/${action}`, {
      method: 'POST',
      body,
    })
    showNotice('')
    await loadJob(jobId)
    await refreshJobs()
    await loadProjects()
  } catch (error) {
    showNotice(`${action}: ${error.message}`, { error: true })
    await refreshJob()
  }
}

function renderEvents() {
  const list = $('#job-events')
  const previousScroll = list.scrollTop
  const nearBottom = list.scrollHeight - list.clientHeight - list.scrollTop < 40
  clear(list)
  const events = state.events.slice(-120)
  if (events.length === 0) {
    list.append(node('li', { class: 'muted', text: 'Waiting for the first event…' }))
    return
  }
  for (const event of events) {
    list.append(
      node('li', {}, [
        node('span', { class: 'event-time', text: timeOfDay(event.at) }),
        node('span', { class: `event-dot ${event.level ?? 'info'}`, attrs: { 'aria-hidden': 'true' } }),
        node('span', { class: 'event-message', text: event.message ?? event.type }),
      ]),
    )
  }
  list.scrollTop = nearBottom ? list.scrollHeight : previousScroll
}

function renderVerification(job) {
  const container = $('#verify-steps')
  clear(container)
  const verification = job.verification
  $('#verify-summary').textContent = verification
    ? verification.ok
      ? 'verified'
      : 'not verified'
    : 'pending'
  if (!verification) {
    container.append(node('p', { class: 'muted small', text: 'Verification runs only after the file-policy check passes.' }))
    return
  }
  for (const step of verification.steps ?? []) {
    const failed = step.ok === false && !(step.available === false && step.skipped)
    const skipped = step.available === false && step.skipped
    container.append(
      node('div', { class: `verify-step${failed ? ' fail' : skipped ? ' skip' : ''}` }, [
        node('div', { class: 'verify-step-head' }, [
          node('strong', { text: step.label ?? step.id ?? 'Step' }),
          node('span', {
            class: `badge ${failed ? 'badge-off' : skipped ? 'badge-warn' : 'badge-ok'}`,
            text: skipped ? 'skipped' : step.ok ? 'pass' : 'fail',
          }),
        ]),
        step.summary
          ? node('p', { text: `${step.summary.passed ?? 0} passed · ${step.summary.failed ?? 0} failed` })
          : null,
        step.reason ? node('p', { text: step.reason }) : null,
        step.inputVerified ? node('p', { text: 'Observed input → state change in a real window.' }) : null,
        ...(step.failures ?? []).slice(0, 5).map((failure) => node('p', { text: failure })),
        ...(step.errors ?? []).slice(0, 5).map((failure) => node('p', { text: failure })),
      ]),
    )
  }
  if (verification.summary) {
    container.append(node('p', { class: 'muted small', text: verification.summary }))
  }
}

function renderChangedFiles(job) {
  const container = $('#changed-files')
  clear(container)
  const changed = job.changedFiles ?? []
  $('#changed-summary').textContent = changed.length ? `${changed.length} file(s)` : 'none'
  if (changed.length === 0) {
    container.append(node('p', { class: 'muted small', text: 'No candidate diff is recorded yet.' }))
    return
  }
  const table = node('table', { class: 'files' }, [
    node('thead', {}, [
      node('tr', {}, [
        node('th', { text: 'File' }),
        node('th', { text: 'Status' }),
        node('th', { text: 'Size' }),
        node('th', { text: 'Before' }),
        node('th', { text: 'After' }),
      ]),
    ]),
  ])
  const body = node('tbody')
  for (const entry of changed) {
    body.append(
      node('tr', {}, [
        node('td', { class: 'path', text: entry.file }),
        node('td', { text: entry.status }),
        node('td', { text: `${bytes(entry.beforeBytes)} → ${bytes(entry.afterBytes)}` }),
        node('td', { text: shortHash(entry.beforeSha256, 10) }),
        node('td', { text: shortHash(entry.afterSha256, 10) }),
      ]),
    )
  }
  table.append(body)
  container.append(table)
}

function renderJobGallery(job) {
  const container = $('#job-gallery')
  clear(container)
  const artifacts = job.artifacts ?? {}
  const entries = [
    ['before', 'Before — untouched workspace'],
    ['after', 'After — verified candidate'],
  ]
  let count = 0
  for (const [key, label] of entries) {
    const artifact = artifacts[key]
    if (!artifact?.path) continue
    count += 1
    container.append(
      node('figure', { class: 'shot' }, [
        node('img', {
          src: jobArtifactUrl(job.id, artifact.path),
          alt: label,
          loading: 'lazy',
        }),
        node('figcaption', {
          text: `${label} · ${bytes(artifact.bytes)} · ${shortHash(artifact.sha256, 10)}`,
        }),
      ]),
    )
  }
  if (count === 0) {
    container.append(
      node('p', {
        class: 'muted small',
        text: 'No before/after frames were recorded (the project may not configure a native smoke scenario).',
      }),
    )
  }
}

function jobArtifactUrl(jobId, relativePath) {
  const encoded = String(relativePath)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')
  return `/api/studio/jobs/${encodeURIComponent(jobId)}/artifacts/${encoded}`
}

function renderAttempts(job) {
  const container = $('#attempts')
  clear(container)
  const attempts = job.attempts ?? []
  if (attempts.length === 0) {
    container.append(node('p', { class: 'muted small', text: 'No agent attempt has started.' }))
    return
  }
  for (const attempt of attempts) {
    const summary = attempt.agent?.summary
    const tools = summary?.tools
      ? Object.entries(summary.tools)
          .map(([name, statuses]) => `${name}(${Object.values(statuses).reduce((a, b) => a + b, 0)})`)
          .join(' ')
      : ''
    container.append(
      node('div', { class: 'attempt' }, [
        node('div', { class: 'attempt-head' }, [
          node('strong', { text: `Attempt ${attempt.attempt}` }),
          node('span', { class: 'muted small', text: attempt.model ?? '' }),
          node('span', {
            class: `badge ${attempt.status === 'passed' ? 'badge-ok' : attempt.status === 'running' ? 'badge-quiet' : 'badge-off'}`,
            text: attempt.status ?? 'unknown',
          }),
          node('span', {
            class: 'muted small',
            text: attempt.agent?.durationMs ? `${(attempt.agent.durationMs / 1000).toFixed(1)} s` : '',
          }),
        ]),
        node('p', {
          class: 'muted small',
          text: tools ? `Tools: ${tools}` : 'No tool calls recorded.',
        }),
        attempt.failure ? node('pre', { text: attempt.failure }) : null,
      ]),
    )
  }
}

async function loadDiff() {
  const job = state.job
  if (!job) return
  const view = $('#diff-view')
  if (state.diffCache.has(job.id)) {
    renderDiffText(view, state.diffCache.get(job.id))
    view.hidden = false
    return
  }
  try {
    const response = await fetch(`/api/studio/jobs/${encodeURIComponent(job.id)}/diff`)
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
    }
    const text = await response.text()
    state.diffCache.set(job.id, text)
    renderDiffText(view, text)
    view.hidden = false
  } catch (error) {
    showNotice(`Diff: ${error.message}`, { error: true })
  }
}

function renderDiffText(container, text) {
  clear(container)
  const lines = String(text ?? '').split(/\r?\n/)
  const fragment = document.createDocumentFragment()
  for (const line of lines) {
    let className = 'diff-line'
    if (line.startsWith('+++') || line.startsWith('---')) className += ' diff-meta'
    else if (line.startsWith('@@')) className += ' diff-hunk'
    else if (line.startsWith('+')) className += ' diff-add'
    else if (line.startsWith('-')) className += ' diff-del'
    fragment.append(node('span', { class: className, text: line || ' ' }))
  }
  container.append(fragment)
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

async function loadOps() {
  if (!state.projectId) return
  try {
    const { ops } = await api(`/api/studio/ops?projectId=${encodeURIComponent(state.projectId)}&limit=40`)
    state.ops = ops
    if (!state.lastOp && ops.length > 0) state.lastOp = ops[0]
    harvestArtifacts(ops)
    renderOps()
    renderPreview()
  } catch (error) {
    showNotice(`Operations: ${error.message}`, { error: true })
  }
}

function harvestArtifacts(records, { prepend = false } = {}) {
  const seen = new Set(state.gallery.map((entry) => entry.url))
  const additions = []
  for (const record of records) {
    const artifact = record.artifact
    if (!artifact?.url || seen.has(artifact.url)) continue
    seen.add(artifact.url)
    additions.push({
      url: artifact.url,
      label: `${record.op} · ${dateTime(record.startedAt)}`,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })
  }
  state.gallery = prepend ? [...additions.reverse(), ...state.gallery] : [...state.gallery, ...additions]
}

function renderOps() {
  renderOpHistory()
  renderOpGallery()
  if (state.lastOp) renderOp(state.lastOp)
}

function renderOpHistory() {
  const list = $('#op-history')
  clear(list)
  if (state.ops.length === 0) {
    list.append(node('li', { class: 'muted', text: 'No operations recorded yet.' }))
    return
  }
  for (const record of state.ops.slice(0, 12)) {
    list.append(
      node('li', {}, [
        node('button', {
          type: 'button',
          text: `${record.op} · ${timeOfDay(record.startedAt)}`,
          onclick: () => {
            state.lastOp = record
            renderOp(record)
          },
        }),
        node('span', {
          class: `badge ${record.status === 'ok' ? 'badge-ok' : record.status === 'running' ? 'badge-quiet' : 'badge-off'}`,
          text: record.status,
        }),
      ]),
    )
  }
}

function renderOpGallery() {
  const container = $('#op-gallery')
  clear(container)
  $('#gallery-count').textContent = `${state.gallery.length} frame(s)`
  if (state.gallery.length === 0) {
    container.append(
      node('p', { class: 'muted small', text: 'Capture a frame from a running native window to fill this gallery.' }),
    )
    return
  }
  for (const entry of state.gallery.slice(0, 12)) {
    container.append(
      node('figure', { class: 'shot' }, [
        node('img', { src: entry.url, alt: entry.label, loading: 'lazy' }),
        node('figcaption', {
          text: `${entry.label}${entry.bytes ? ` · ${bytes(entry.bytes)}` : ''}`,
        }),
      ]),
    )
  }
}

function renderOp(record) {
  const container = $('#op-result')
  clear(container)
  const status = $('#op-status')
  status.textContent = record ? `${record.status} · ${record.durationMs ?? 0} ms` : ''
  if (!record) {
    container.append(node('p', { class: 'muted', text: 'Run an operation to see its real result.' }))
    return
  }
  container.append(
    node('p', {}, [
      node('strong', { text: record.label ?? record.op }),
      node('span', { class: 'muted small', text: ` · ${dateTime(record.startedAt)}` }),
    ]),
  )
  if (record.summary) container.append(node('p', { text: record.summary }))
  if (record.error) {
    container.append(
      node('p', { class: 'badge badge-off', text: `${record.error.class}: ${record.error.message}` }),
    )
  }

  const result = record.result
  if (record.op === 'check' && result) {
    container.append(
      node('p', {
        text: `${result.fileCount} script(s) · mode ${result.mode} · ${result.errors?.length ?? 0} error(s)`,
      }),
    )
    if (result.errors?.length) {
      container.append(node('ul', {}, result.errors.slice(0, 10).map((line) => node('li', { text: line }))))
    }
  } else if (record.op === 'test' && result) {
    container.append(
      node('p', {
        text: `${result.suite?.label ?? 'Suite'} · ${result.summary?.passed ?? 0} passed · ${result.summary?.failed ?? 0} failed`,
      }),
    )
    if (result.failures?.length) {
      container.append(
        node('ul', {}, result.failures.slice(0, 10).map((failure) => node('li', { text: `${failure.name}: ${failure.detail}` }))),
      )
    }
  } else if (record.op === 'advance' && result?.snapshot) {
    const snapshot = result.snapshot
    container.append(
      node('p', {
        text: `ticks=${snapshot.physics_frames ?? '—'} paused=${String(snapshot.paused ?? '—')} player=${JSON.stringify(snapshot.player_position ?? null)}`,
      }),
    )
  } else if (record.op === 'capture' && result?.frame) {
    container.append(
      node('p', {
        text: `${result.frame.width ?? '?'}×${result.frame.height ?? '?'} · paused=${String(result.frame.paused)} · ${result.frame.simTimeSeconds?.toFixed?.(2) ?? '—'} s`,
      }),
    )
    if (record.artifact?.url) {
      container.append(
        node('figure', { class: 'shot' }, [
          node('img', { src: record.artifact.url, alt: 'Captured frame', loading: 'lazy' }),
          node('figcaption', { text: `sha256 ${shortHash(record.artifact.sha256, 16)}` }),
        ]),
      )
    }
  } else if (result) {
    container.append(node('pre', { class: 'log-view', text: JSON.stringify(result, null, 2) }))
  }

  const logs = $('#op-logs')
  const lines = []
  if (record.logs?.stdout?.length) lines.push(`[stdout]\n${record.logs.stdout.join('\n')}`)
  if (record.logs?.stderr?.length) lines.push(`[stderr]\n${record.logs.stderr.join('\n')}`)
  logs.textContent = lines.length ? lines.join('\n\n') : 'No console output recorded.'
}

function setOpBusy(busy) {
  state.busyOp = busy
  $('#op-busy').hidden = !busy
  for (const button of $$('[data-op]')) {
    if (button.dataset.op !== 'stop' || !busy) button.disabled = busy
  }
}

async function runOp(op) {
  if (state.busyOp || !state.projectId) return
  const args = {}
  if (op === 'test') {
    const testId = $('#test-select').value
    if (!testId) {
      showNotice('No test suite is registered for this project.', { error: true })
      return
    }
    args.testId = testId
  }
  if (op === 'advance') args.steps = 30
  setOpBusy(true)
  showNotice(`Running ${op}…`)
  try {
    const { op: record } = await api('/api/studio/ops', {
      method: 'POST',
      body: { projectId: state.projectId, op, args },
    })
    state.lastOp = record
    state.ops.unshift(record)
    harvestArtifacts([record], { prepend: true })
    renderOps()
    if (record.status !== 'ok') {
      showNotice(`${op}: ${record.error?.message ?? record.summary ?? 'failed'}`, { error: true })
    } else {
      showNotice('')
    }
    await Promise.allSettled([loadPreview(), loadProjects()])
  } catch (error) {
    showNotice(`${op}: ${error.message}`, { error: true })
  } finally {
    setOpBusy(false)
  }
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

async function loadPreview() {
  if (!state.projectId) return
  try {
    state.preview = await api(`/api/studio/projects/${encodeURIComponent(state.projectId)}/preview`)
    renderPreview()
  } catch (error) {
    state.preview = { native: { running: false }, browser: null, error: error.message }
    renderPreview()
  }
}

function renderPreview() {
  const preview = state.preview
  const nativeState = $('#native-state')
  const browserState = $('#browser-state')
  const nativeFrame = $('#native-frame')
  const browserFrame = $('#browser-frame')
  if (!preview) return

  const native = preview.native ?? { running: false }
  nativeState.textContent = native.running ? `running · pid ${native.pid}` : 'not running'
  const latest = state.gallery.find((entry) => entry.url)
  if (latest) {
    clear(nativeFrame)
    nativeFrame.append(node('img', { src: latest.url, alt: 'Latest native capture', loading: 'lazy' }))
  } else if (!native.running) {
    clear(nativeFrame)
    nativeFrame.append(
      node('p', { class: 'muted small', text: 'Launch a native window, then capture a real frame.' }),
    )
  }

  const project = state.project
  const browser = preview.browser
  if (!browser || !browser.configured) {
    browserState.textContent = 'not registered'
    clear(browserFrame)
    browserFrame.append(
      node('p', {
        class: 'muted small',
        text: 'This project has no browser build registered. Use the native window instead.',
      }),
    )
    $('#browser-note').textContent = ''
    return
  }

  browserState.textContent = browser.reachable ? `reachable · HTTP ${browser.status}` : 'unreachable'
  if (browser.reachable) {
    // Only mount the WebGL build when the Preview tab is actually on screen, and
    // keep it mounted afterwards so switching tabs does not restart the game.
    const mounted = browserFrame.querySelector('iframe')
    const stale = mounted && mounted.getAttribute('src') !== browser.url
    if (stale) clear(browserFrame)
    if ((!mounted || stale) && state.activeTab === 'preview') {
      clear(browserFrame)
      browserFrame.append(
        node('iframe', {
          src: browser.url,
          title: `${project?.name ?? 'Project'} browser build`,
          // The voxel build captures the mouse for look controls. Without the
          // pointer-lock permission policy the iframe request is rejected, so
          // grant it explicitly.
          allow: 'fullscreen; gamepad; pointer-lock',
        }),
      )
    }
    $('#browser-note').textContent = `${browser.label}. This is the canonical browser build, not the agent candidate.`
  } else {
    clear(browserFrame)
    browserFrame.append(
      node('div', { class: 'card' }, [
        node('strong', { text: 'The browser build is not reachable.' }),
        node('p', { class: 'small', text: browser.error ?? `No response from ${browser.url}.` }),
        node('p', {
          class: 'small',
          text: 'Start the canonical loopback build with experiments/godot-harness/controller/voxel-web.mjs --no-export, then refresh this panel. The Studio does not start an unrestricted web process from the browser.',
        }),
      ]),
    )
    $('#browser-note').textContent = `Registered URL: ${browser.url}`
  }
}

/* ------------------------------------------------------------------ */
/* Tabs and wiring                                                     */
/* ------------------------------------------------------------------ */

function switchTab(name) {
  state.activeTab = name
  for (const button of $$('.tab')) {
    const active = button.dataset.tab === name
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', String(active))
  }
  for (const panel of $$('.panel')) {
    const active = panel.id === `panel-${name}`
    panel.classList.toggle('is-active', active)
    panel.hidden = !active
  }
  if (name === 'preview') loadPreview()
  if (name === 'jobs') refreshJobs().catch((error) => showNotice(error.message, { error: true }))
  if (name === 'operations') loadOps()
}

function wire() {
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab))
  }
  $('#refresh-projects').addEventListener('click', async () => {
    try {
      await loadProjects()
      if (state.projectId) await selectProject(state.projectId, { keepJob: true })
    } catch (error) {
      showNotice(error.message, { error: true })
    }
  })
  $('#refresh-jobs').addEventListener('click', () => refreshJobs().catch((error) => showNotice(error.message, { error: true })))
  $('#new-project').addEventListener('click', () => {
    openCreateDialog().catch((error) => showNotice(`Could not open the creation dialog: ${error.message}`, { error: true }))
  })
  $('#create-cancel').addEventListener('click', closeCreateDialog)
  $('#create-form').addEventListener('submit', submitCreate)
  $('#build-form').addEventListener('submit', submitBuild)
  $('#load-diff').addEventListener('click', loadDiff)
  for (const button of $$('[data-op]')) {
    button.addEventListener('click', () => runOp(button.dataset.op))
  }

  $('#task-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const task = $('#task-input').value.trim()
    if (task.length < 10) {
      showNotice('Describe the task in at least 10 characters.', { error: true })
      return
    }
    const submit = $('#submit-task')
    submit.disabled = true
    submit.textContent = 'Starting…'
    showNotice('Creating an isolated workspace and recording the baseline…')
    try {
      const { job } = await api('/api/studio/jobs', {
        method: 'POST',
        body: {
          projectId: state.projectId,
          task,
          model: $('#model-select').value,
        },
      })
      state.jobId = job.id
      showNotice('')
      await loadJob(job.id)
      await refreshJobs()
      await loadProjects()
    } catch (error) {
      showNotice(`${error.code === 'agent_disabled' ? 'Agent unavailable' : 'Could not start'}: ${error.message}`, {
        error: true,
      })
    } finally {
      submit.textContent = 'Start isolated run'
      submit.disabled = !state.project?.agent?.enabled
    }
  })
}

async function boot() {
  wire()
  try {
    state.meta = await api('/api/studio/meta')
    $('#server-info').textContent = `Started ${dateTime(state.meta.startedAt)} · ${state.meta.models.length} model(s)`
    $('#footer-server').textContent = `Studio server · ${state.meta.limits.maxBodyBytes} B body limit · ${state.meta.limits.maxArtifactBytes} B artifact limit`
    const projects = await loadProjects()
    initBuildForm()
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''))
    const requestedJob = hash.get('job')
    const requestedProject = hash.get('project')
    const initial =
      projects.find((project) => project.id === requestedProject) ??
      projects.find((project) => project.id === 'voxel-sandbox') ??
      projects[0]
    if (!initial) {
      showNotice('No projects are registered.', { error: true })
      return
    }
    await selectProject(initial.id)
    if (requestedJob) {
      switchTab('task')
      await loadJob(requestedJob)
    }
    setConnection('live', 'Ready')
  } catch (error) {
    setConnection('error', 'Offline')
    showNotice(`The Studio API is unavailable: ${error.message}`, { error: true })
  }
}

boot()
