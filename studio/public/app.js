const GROUP_LABELS = {
  runtime: 'Runtime observation',
  repair: 'Repair experiment',
  export: 'Packaged export',
  measurements: 'Measurements',
  web: 'Browser session',
  tooling: 'Tooling gaps',
  'agent-runs': 'Agent implementation',
}

const VERDICT_LABELS = {
  'verified-pass': 'Verified pass',
  'verified-fail': 'Verified fail',
  informational: 'Informational',
  recorded: 'Human-recorded',
  'model-claim-rejected': 'Model claim rejected',
}

const PROVENANCE_LABELS = {
  'trusted-runner': 'Trusted runner',
  'human-recorded': 'Human-recorded',
  'model-generated': 'Model-generated',
}

const state = {
  runs: [],
  meta: null,
  selectedId: null,
  filters: { text: '', group: '', verdict: '', provenance: '' },
}

const dom = {
  runCount: document.querySelector('#run-count'),
  runList: document.querySelector('#run-list'),
  empty: document.querySelector('#empty-state'),
  detail: document.querySelector('#run-detail'),
  footMeta: document.querySelector('#foot-meta'),
  filterText: document.querySelector('#filter-text'),
  filterGroup: document.querySelector('#filter-group'),
  filterVerdict: document.querySelector('#filter-verdict'),
  filterProvenance: document.querySelector('#filter-provenance'),
}

function h(tag, options = {}, children = []) {
  const node = document.createElement(tag)
  if (options.className) node.className = options.className
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text)
  if (options.href) node.href = options.href
  if (options.title) node.title = options.title
  if (options.type) node.type = options.type
  if (options.value !== undefined) node.value = options.value
  if (options.id) node.id = options.id
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value !== null && value !== undefined) node.setAttribute(name, String(value))
  }
  for (const [name, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(name, handler)
  }
  const list = Array.isArray(children) ? children : [children]
  for (const child of list.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function badge(type, value) {
  const label = type === 'verdict'
    ? VERDICT_LABELS[value] ?? value
    : type === 'provenance'
      ? PROVENANCE_LABELS[value] ?? value
      : value
  return h('span', { className: `badge ${type} ${value}`, text: label })
}

function banner(kind, title, body) {
  return h('div', { className: `banner ${kind}` }, [
    h('strong', { text: title }),
    h('span', { text: body }),
  ])
}

function formatDate(value) {
  if (!value) return 'not recorded'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.toLocaleString()} (${date.toISOString()})`
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

function shortId(id) {
  const parts = id.split('/')
  return parts[parts.length - 1]
}

function fileUrl(rel) {
  return `/api/file?path=${encodeURIComponent(rel)}`
}

function textUrl(rel) {
  return `/api/text?path=${encodeURIComponent(rel)}`
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const message = body?.error?.message ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return body
}

function matchesFilters(run) {
  const { text, group, verdict, provenance } = state.filters
  if (group && run.group !== group) return false
  if (verdict && run.verdict !== verdict) return false
  if (provenance && run.provenance !== provenance) return false
  if (text) {
    const haystack = `${run.id} ${run.headline} ${run.group} ${run.kind}`.toLowerCase()
    if (!haystack.includes(text.toLowerCase())) return false
  }
  return true
}

function renderRunList() {
  const visible = state.runs.filter(matchesFilters)
  dom.runList.replaceChildren()

  for (const run of visible) {
    const button = h(
      'button',
      {
        type: 'button',
        attrs: {
          'aria-current': run.id === state.selectedId ? 'true' : 'false',
          'data-run-id': run.id,
        },
        on: { click: () => selectRun(run.id) },
      },
      [
        h('span', { className: 'run-top' }, [
          h('span', { className: 'run-group', text: GROUP_LABELS[run.group] ?? run.group }),
          h('span', { className: 'run-date', text: formatShortDate(run) }),
        ]),
        h('span', { className: 'run-headline', text: run.headline }),
        h('span', { className: 'run-badges' }, [
          badge('verdict', run.verdict),
          badge('provenance', run.provenance),
        ]),
      ],
    )
    dom.runList.append(h('li', {}, button))
  }

  dom.runCount.textContent = `${visible.length} of ${state.runs.length} runs`
  dom.empty.hidden = visible.length > 0
}

function formatShortDate(run) {
  const value = run.startedAt ?? shortId(run.id).replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  )
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function populateFilters() {
  const groups = [...new Set(state.runs.map((run) => run.group))].sort()
  const verdicts = [...new Set(state.runs.map((run) => run.verdict))].sort()
  const provenances = [...new Set(state.runs.map((run) => run.provenance))].sort()

  for (const group of groups) {
    dom.filterGroup.append(h('option', { value: group, text: GROUP_LABELS[group] ?? group }))
  }
  for (const verdict of verdicts) {
    dom.filterVerdict.append(h('option', { value: verdict, text: VERDICT_LABELS[verdict] ?? verdict }))
  }
  for (const provenance of provenances) {
    dom.filterProvenance.append(
      h('option', { value: provenance, text: PROVENANCE_LABELS[provenance] ?? provenance }),
    )
  }
}

function selectRun(id) {
  state.selectedId = id
  renderRunList()
  renderDetailById(id)

  // Render first, then update the address. Relying on the hashchange event
  // alone would leave the detail pane empty on the very first selection.
  const nextHash = `#/run/${encodeURIComponent(id)}`
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash
  }
}

function readHash() {
  const hash = window.location.hash
  if (!hash.startsWith('#/run/')) return null
  try {
    return decodeURIComponent(hash.slice('#/run/'.length))
  } catch {
    return null
  }
}

function renderDetailById(id) {
  const run = state.runs.find((item) => item.id === id)
  if (!run) {
    renderPlaceholder('Run not found', 'That run id is not in the scanned evidence index.')
    return
  }
  renderDetail(run)
}

function renderPlaceholder(title, body) {
  dom.detail.replaceChildren(
    h('div', { className: 'placeholder' }, [h('h2', { text: title }), h('p', { text: body })]),
  )
}

function renderDetail(run) {
  const fragment = document.createDocumentFragment()

  fragment.append(
    h('div', { className: 'detail-head' }, [
      h('div', {}, [
        h('div', { className: 'badge-row' }, [
          badge('verdict', run.verdict),
          badge('provenance', run.provenance),
          h('span', { className: 'badge kind', text: GROUP_LABELS[run.group] ?? run.group }),
        ]),
        h('h2', { text: run.headline }),
        h('p', {
          className: 'ids',
          text: `${run.group} · ${run.id} · ${run.kind}`,
        }),
      ]),
      run.manifest
        ? h('a', { href: fileUrl(run.manifest.rel), text: 'Open raw manifest', attrs: { target: '_blank', rel: 'noreferrer' } })
        : h('span', { className: 'muted', text: 'No manifest recorded' }),
    ]),
  )

  fragment.append(renderProvenanceBanner(run))
  if (run.failure) fragment.append(renderFailure(run.failure))
  fragment.append(renderCounts(run))
  fragment.append(renderMeta(run))
  fragment.append(renderVerification(run))

  if (run.kind === 'repair-experiment') fragment.append(renderRepairStages(run))
  if (run.kind === 'measurements') fragment.append(renderMeasurements(run))
  if (run.kind === 'agent-implementation-run') fragment.append(renderAgentRun(run))

  if (run.checks.length) fragment.append(renderChecks(run))
  if (run.comparisons.length) fragment.append(renderComparisons(run))
  if (run.comparisonImages.length) fragment.append(renderComparisonImages(run))
  if (run.gallery.length) fragment.append(renderCaptures(run))
  if (run.videos.length) fragment.append(renderVideos(run))
  if (run.files.length) fragment.append(renderFiles(run))

  dom.detail.replaceChildren(fragment)
}

function renderProvenanceBanner(run) {
  if (run.provenance === 'model-generated') {
    return banner(
      'model',
      'Model-generated material — not evidence of correctness',
      'This run contains an external agent transcript or its candidate copy. The agent produced text and code; it did not decide whether they work. Only the trusted runner stages, where present, carry verification weight.',
    )
  }
  if (run.provenance === 'human-recorded') {
    return banner(
      'human',
      'Human-recorded — not a runner gate',
      'A person captured this session by hand (Playwright MCP + ffmpeg). It is useful evidence of what was on screen, but it is not a reproducible automated check.',
    )
  }
  if (run.verdict === 'verified-fail') {
    return banner(
      'fail',
      'Runner-verified failure',
      'A trusted runner reached this result and recorded the failure. The failing check and the raw error are shown below rather than hidden.',
    )
  }
  if (run.verdict === 'verified-pass') {
    return banner(
      'verified',
      'Runner-verified pass',
      'A trusted runner produced this result. It describes this host at capture time; it is not a general guarantee.',
    )
  }
  return banner(
    'human',
    'Informational only — no pass/fail gate',
    'This record reports measurements or context. S0 does not turn it into a pass or fail.',
  )
}

function renderFailure(failure) {
  const firstLine = String(failure).split(/\r?\n/)[0]
  return h('div', {}, [
    banner('fail', 'Recorded failure', firstLine),
    h('details', { className: 'file-group' }, [
      h('summary', { text: 'Full failure text' }),
      h('pre', { className: 'failure-pre', text: String(failure) }),
    ]),
  ])
}

function countLabels(run) {
  if (run.verdict === 'recorded') return { passed: 'recorded', failed: null, total: 'items' }
  if (run.kind === 'agent-implementation-run') {
    return { passed: 'accepted', failed: 'rejected', total: 'attempts' }
  }
  if (run.kind === 'repair-experiment') {
    return { passed: 'candidate checks passed', failed: 'failed', total: 'checks' }
  }
  return { passed: 'passed', failed: 'failed', total: 'total' }
}

function renderCounts(run) {
  const labels = countLabels(run)
  const items = []
  if (Number.isFinite(run.passed)) {
    items.push(h('li', {}, [h('strong', { text: String(run.passed) }), ` ${labels.passed}`]))
  }
  if (labels.failed && Number.isFinite(run.failed)) {
    items.push(h('li', {}, [h('strong', { text: String(run.failed) }), ` ${labels.failed}`]))
  }
  if (Number.isFinite(run.total)) {
    items.push(h('li', {}, [h('strong', { text: String(run.total) }), ` ${labels.total}`]))
  }
  if (!items.length) return h('div')
  return h('ul', { className: 'counts' }, items)
}

function renderMeta(run) {
  const entries = [
    ['Started / recorded', formatDate(run.startedAt)],
    run.finishedAt ? ['Finished', formatDate(run.finishedAt)] : null,
    run.model ? ['Model named in manifest', run.model] : null,
    ['Evidence id', run.id],
    run.parseError ? ['Parse error', run.parseError] : null,
  ].filter(Boolean)

  return h(
    'dl',
    { className: 'meta-grid' },
    entries.map(([term, value]) => h('div', {}, [h('dt', { text: term }), h('dd', { text: value })])),
  )
}

function renderVerification(run) {
  return h('section', {}, [
    h('h3', { text: 'How this was verified' }),
    h('p', { className: 'basis', text: run.verificationBasis }),
    run.caveats.length
      ? h('ul', { className: 'caveats' }, run.caveats.map((caveat) => h('li', { text: caveat })))
      : null,
  ])
}

function resultFor(run, pass) {
  if (!pass) return run.kind === 'agent-implementation-run' ? 'REJECTED' : 'FAIL'
  if (run.verdict === 'recorded') return 'RECORDED'
  if (run.verdict === 'informational') return 'INFO'
  if (run.kind === 'agent-implementation-run') return 'ACCEPTED'
  return 'PASS'
}

function resultClass(run, pass) {
  if (!pass) return 'fail'
  if (run.verdict === 'recorded') return 'recorded'
  if (run.verdict === 'informational') return ''
  return 'pass'
}

function renderChecks(run) {
  const passed = run.checks.filter((check) => check.pass).length
  const title = run.kind === 'agent-implementation-run'
    ? 'Attempts'
    : run.verdict === 'recorded'
      ? 'Recorded interactions'
      : 'Checks'

  const rows = run.checks.map((check) =>
    h('tr', {}, [
      h('td', { text: check.name }),
      h('td', { className: `result ${resultClass(run, check.pass)}`, text: resultFor(run, check.pass) }),
      h('td', { className: 'muted', text: check.detail ?? '' }),
    ]),
  )

  return h('section', {}, [
    h('h3', {}, [
      title,
      h('span', { className: 'muted', text: `${passed} of ${run.checks.length} marked pass/recorded` }),
    ]),
    h('div', { className: 'table-wrap' }, [
      h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: title === 'Attempts' ? 'Attempt' : 'Name' }),
          h('th', { text: 'Result' }),
          h('th', { text: 'Detail' }),
        ])),
        h('tbody', {}, rows),
      ]),
    ]),
    run.failure && passed === run.checks.length
      ? h('p', {
          className: 'muted',
          text: 'Every check that ran passed; the failure was recorded after them, so this run is still a verified failure.',
        })
      : null,
  ])
}

function renderRepairStages(run) {
  const details = run.details ?? {}
  const stages = []

  if (details.defect) {
    const summary = details.defect.summary ?? {}
    const total = (summary.passed ?? 0) + (summary.failed ?? 0)
    stages.push(
      h('tr', {}, [
        h('td', { text: 'Injected defect: hidden suite' }),
        h('td', {
          className: `result ${summary.failed > 0 ? 'fail' : 'recorded'}`,
          text: `${summary.passed ?? 0}/${total}`,
        }),
        h('td', {
          className: 'muted',
          text: details.defect.failing_checks?.length
            ? `Failing: ${details.defect.failing_checks.join(', ')}`
            : 'No failing checks recorded; the defect was not detected.',
        }),
      ]),
    )
  }

  if (details.agent) {
    const total = (details.agent.summary?.passed ?? 0) + (details.agent.summary?.failed ?? 0)
    stages.push(
      h('tr', {}, [
        h('td', { text: 'External agent candidate: hidden suite' }),
        h('td', {
          className: `result ${details.agent.verification_ok ? 'pass' : 'fail'}`,
          text: details.agent.summary ? `${details.agent.summary.passed}/${total}` : 'not run',
        }),
        h('td', {
          className: 'muted',
          text: `changed=${String(details.agent.changed)} · ${details.agent.duration_ms ?? '?'} ms · timeout=${String(details.agent.timed_out)} · failing=${(details.agent.failing_checks ?? []).join(', ') || 'none'}`,
        }),
      ]),
    )
  }

  if (details.trusted) {
    stages.push(
      h('tr', {}, [
        h('td', { text: 'Trusted repair applied' }),
        h('td', {
          className: `result ${details.trusted.suite_ok ? 'pass' : 'fail'}`,
          text: details.trusted.applied ? 'APPLIED' : 'NOT NEEDED',
        }),
        h('td', { className: 'muted', text: `suite_ok=${String(details.trusted.suite_ok)}` }),
      ]),
    )
  }

  if (details.canonical) {
    stages.push(
      h('tr', {}, [
        h('td', { text: 'Canonical tree untouched' }),
        h('td', {
          className: `result ${details.canonical.unchanged ? 'pass' : 'fail'}`,
          text: details.canonical.unchanged ? 'UNCHANGED' : 'CHANGED',
        }),
        h('td', {
          className: 'muted',
          text: `${String(details.canonical.healthy_sha256_before ?? '').slice(0, 12)}… → ${String(details.canonical.healthy_sha256_after ?? '').slice(0, 12)}…`,
        }),
      ]),
    )
  }

  const actorBlock = details.actors
    ? h('div', { className: 'meta-grid' }, [
        h('div', {}, [
          h('dt', { text: 'External agent actions (model-generated)' }),
          h('dd', {}, h('ul', { className: 'caveats' }, (details.actors.agent ?? []).map((item) => h('li', { text: item })))),
        ]),
        h('div', {}, [
          h('dt', { text: 'Trusted runner actions' }),
          h('dd', {}, h('ul', { className: 'caveats' }, (details.actors.trusted_runner ?? []).map((item) => h('li', { text: item })))),
        ]),
      ])
    : null

  return h('section', {}, [
    h('h3', { text: 'Experiment stages' }),
    h('div', { className: 'table-wrap' }, [
      h('table', {}, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: 'Stage' }),
          h('th', { text: 'Result' }),
          h('th', { text: 'Detail' }),
        ])),
        h('tbody', {}, stages),
      ]),
    ]),
    details.ordering?.length
      ? h('p', { className: 'muted', text: `Ordering: ${details.ordering.join(' → ')}` })
      : null,
    actorBlock,
  ])
}

function renderMeasurements(run) {
  const details = run.details ?? {}
  const system = details.system ?? {}
  const rows = [
    ['Host', `${system.platform ?? '?'} ${system.arch ?? ''}`.trim()],
    ['CPU', system.cpu ?? 'not recorded'],
    ['GPU', system.gpu ?? 'not recorded'],
    ['Logical CPUs', system.logical_cpus ?? 'not recorded'],
    ['Memory', Number.isFinite(system.total_memory_bytes) ? formatBytes(system.total_memory_bytes) : 'not recorded'],
    ['CPU probe ok', String(details.cpu_ok)],
    ['Runtime probe ok', String(details.runtime_ok)],
    ['Launch duration', details.launch_duration_ms !== null && details.launch_duration_ms !== undefined ? `${details.launch_duration_ms} ms` : 'not recorded'],
    ['FPS samples', (details.fps_samples ?? []).join(', ') || 'not recorded'],
  ]

  return h('section', {}, [
    h('h3', { text: 'Measurements' }),
    h(
      'dl',
      { className: 'meta-grid' },
      rows.map(([term, value]) => h('div', {}, [h('dt', { text: term }), h('dd', { text: String(value) })])),
    ),
    details.notes?.length
      ? h('ul', { className: 'caveats' }, details.notes.map((note) => h('li', { text: note })))
      : null,
  ])
}

function renderAgentRun(run) {
  const details = run.details ?? {}
  const same =
    details.hidden_test_sha256_before &&
    details.hidden_test_sha256_before === details.hidden_test_sha256_after

  return h('section', {}, [
    h('h3', { text: 'Runner guardrails' }),
    h('p', {
      className: 'basis',
      text: same
        ? 'The hidden test hash was identical before and after the attempts, so the agent could not have altered the acceptance test.'
        : 'The hidden test hashes differ or are missing; treat the acceptance signal with suspicion.',
    }),
    details.attempts?.length
      ? h('ul', { className: 'caveats' }, details.attempts.map((attempt) =>
          h('li', {
            text: `Attempt ${attempt.attempt}: ${attempt.problems?.length ?? 0} problem(s), ${attempt.duration_ms ?? '?'} ms — ${(attempt.problems ?? []).join('; ') || 'no problems recorded'}`,
          }),
        ))
      : null,
  ])
}

function renderComparisons(run) {
  const section = h('section', {}, [h('h3', { text: 'Before / after comparisons' })])
  for (const comparison of run.comparisons) {
    section.append(comparisonCard(comparison))
  }
  return section
}

function setReveal(stage, percent) {
  const clamped = Math.min(100, Math.max(0, percent))
  stage.style.setProperty('--pos', `${clamped}%`)
  // A division of 0 is invalid in calc(), so the inner box keeps a floor even
  // when the handle is dragged fully to the left.
  stage.style.setProperty('--pos-frac', String(Math.max(clamped, 1) / 100))
}

function comparisonCard(comparison) {
  const stage = h('div', { className: 'stage' })
  const range = h('input', {
    type: 'range',
    value: '50',
    attrs: { min: '0', max: '100', 'aria-label': `Reveal ${comparison.label} before/after` },
  })

  const before = h('img', {
    className: 'before',
    attrs: {
      src: fileUrl(comparison.before.rel),
      alt: `${comparison.label}: before (${comparison.before.name})`,
    },
  })
  const after = h('img', {
    className: 'after',
    attrs: {
      src: fileUrl(comparison.after.rel),
      alt: `${comparison.label}: after (${comparison.after.name})`,
    },
  })

  // The before image is revealed by a plain overflow clip instead of
  // clip-path. On this machine (Chromium at a 1.25 device pixel ratio)
  // clip-path on a scaled image rasterises the PNG tiled across the whole
  // page, so the reveal has to stay a layout-level clip.
  const reveal = h('div', { className: 'reveal' }, [
    h('div', { className: 'reveal-inner' }, [before]),
  ])

  stage.append(
    after,
    reveal,
    h('span', { className: 'divider' }),
    h('span', { className: 'tag left', text: comparison.before.name }),
    h('span', { className: 'tag right', text: comparison.after.name }),
  )
  setReveal(stage, 50)
  range.addEventListener('input', () => {
    setReveal(stage, Number(range.value))
  })

  return h('div', { className: 'comparison' }, [
    h('header', {}, [
      h('span', { text: comparison.label }),
      h('span', { className: 'muted', text: 'drag the slider to reveal before / after' }),
    ]),
    stage,
    range,
  ])
}

function renderComparisonImages(run) {
  return h('section', {}, [
    h('h3', {}, [
      'Diff / compare captures',
      h('span', { className: 'muted', text: 'provided by the run; no pixel score is computed by S0' }),
    ]),
    h('div', { className: 'card-grid' }, run.comparisonImages.map(shotCard)),
  ])
}

function shotCard(capture) {
  const src = fileUrl(capture.rel)
  return h('figure', { className: 'shot' }, [
    h('a', { href: src, attrs: { target: '_blank', rel: 'noreferrer' } }, [
      // No lazy loading: these are local files, and loading every capture up
      // front keeps scrolling and screenshots stable.
      h('img', { attrs: { src, alt: capture.name } }),
    ]),
    h('figcaption', {}, [
      h('span', { text: capture.name }),
      h('span', {
        className: 'muted',
        text: [formatBytes(capture.bytes), capture.width && capture.height ? `${capture.width}x${capture.height}` : null]
          .filter(Boolean)
          .join(' · '),
      }),
    ]),
  ])
}

function renderCaptures(run) {
  return h('section', {}, [
    h('h3', {}, ['Captures', h('span', { className: 'muted', text: `${run.gallery.length} image(s)` })]),
    h('div', { className: 'card-grid' }, run.gallery.map(shotCard)),
  ])
}

function renderVideos(run) {
  return h('section', {}, [
    h('h3', { text: 'Video' }),
    ...run.videos.map((video) => h('video', {
      attrs: { controls: '', preload: 'none', src: fileUrl(video.rel) },
    })),
    h('p', { className: 'muted', text: run.videos.map((video) => `${video.name} (${formatBytes(video.bytes)})`).join(', ') }),
  ])
}

const FILE_GROUP_ORDER = ['text', 'image', 'video', 'other']
const FILE_GROUP_LABELS = {
  text: 'Text and JSON',
  image: 'Images',
  video: 'Video',
  other: 'Other files',
}

function renderFiles(run) {
  const section = h('section', {}, [
    h('h3', {}, [
      'Files in this run',
      h('span', { className: 'muted', text: `${run.files.length} scanned, ${run.files.filter((file) => file.servable).length} servable` }),
    ]),
    h('div', { className: 'file-groups' }),
  ])
  const groups = section.querySelector('.file-groups')

  for (const kind of FILE_GROUP_ORDER) {
    const files = run.files.filter((file) => file.kind === kind)
    if (!files.length) continue

    const container = h('div', {})
    const details = h('details', { className: 'file-group', attrs: { open: kind === 'text' ? '' : null } }, [
      h('summary', { text: `${FILE_GROUP_LABELS[kind]} (${files.length})` }),
      container,
    ])
    for (const file of files) {
      container.append(fileRow(run, file))
    }
    groups.append(details)
  }

  return section
}

function fileRow(run, file) {
  const row = h('div', { className: 'file-row' }, [
    h('span', { className: 'file-name' }, [
      file.path,
      file.provenance === 'model-generated'
        ? h('span', { className: 'badge provenance model-generated', text: 'Model-generated' })
        : null,
      h('span', { className: 'muted', text: ` ${formatBytes(file.bytes)}` }),
    ]),
  ])

  const actions = h('span', { className: 'file-actions' })
  if (!file.servable) {
    actions.append(h('span', { className: 'disabled', text: 'not served (extension)' }))
  } else if (file.kind === 'text') {
    const previewButton = h('button', {
      type: 'button',
      text: 'Preview',
      on: { click: () => togglePreview(row, run, file, previewButton) },
    })
    actions.append(
      previewButton,
      h('a', { href: textUrl(file.rel), text: 'Raw API', attrs: { target: '_blank', rel: 'noreferrer' } }),
    )
  } else {
    actions.append(
      h('a', { href: fileUrl(file.rel), text: 'Open', attrs: { target: '_blank', rel: 'noreferrer' } }),
    )
  }
  row.append(actions)
  return row
}

async function togglePreview(row, run, file, button) {
  const existing = row.querySelector('.preview')
  if (existing) {
    existing.remove()
    button.textContent = 'Preview'
    return
  }

  button.disabled = true
  button.textContent = 'Loading…'
  try {
    const payload = await fetchJson(textUrl(file.rel))
    const preview = h('div', { className: 'preview' }, [
      h('header', {}, [
        h('span', { text: file.path }),
        h('span', {
          text: [
            formatBytes(payload.bytes),
            payload.truncated ? `truncated to ${payload.returnedLines} lines` : `${payload.returnedLines} lines`,
            payload.sha256 ? `sha256 ${payload.sha256.slice(0, 12)}…` : 'sha256 not computed (truncated read)',
          ].join(' · '),
        }),
      ]),
    ])
    if (file.provenance === 'model-generated' || run.provenance === 'model-generated') {
      preview.append(
        h('p', {
          className: 'model-note',
          text: 'Model-generated text. This is the agent’s claim, not a verified result.',
        }),
      )
    }
    preview.append(h('pre', { text: payload.lines.join('\n') }))
    row.append(preview)
    button.textContent = 'Hide'
  } catch (error) {
    const preview = h('div', { className: 'preview' }, [
      h('p', { className: 'error', text: `Preview failed: ${error.message}` }),
    ])
    row.append(preview)
    button.textContent = 'Hide'
  } finally {
    button.disabled = false
  }
}

function applyFilterChange() {
  state.filters.text = dom.filterText.value.trim()
  state.filters.group = dom.filterGroup.value
  state.filters.verdict = dom.filterVerdict.value
  state.filters.provenance = dom.filterProvenance.value
  renderRunList()
}

async function boot() {
  try {
    const [meta, payload] = await Promise.all([fetchJson('/api/meta'), fetchJson('/api/runs')])
    state.meta = meta
    state.runs = payload.runs

    populateFilters()
    renderRunList()
    dom.footMeta.textContent = `Evidence root: ${meta.evidenceRoot} · ${meta.runCount} runs · ${meta.artifactCount} artifacts · scanned ${formatDate(meta.scannedAt)} · model calls: ${meta.modelCalls}`

    const requested = readHash()
    if (requested) {
      selectRun(requested)
    } else if (state.runs.length) {
      selectRun(state.runs[0].id)
    }
  } catch (error) {
    renderPlaceholder('Could not load evidence', error.message)
    dom.runCount.textContent = 'failed to load'
    dom.footMeta.textContent = `Evidence API error: ${error.message}`
  }
}

dom.filterText.addEventListener('input', applyFilterChange)
dom.filterGroup.addEventListener('change', applyFilterChange)
dom.filterVerdict.addEventListener('change', applyFilterChange)
dom.filterProvenance.addEventListener('change', applyFilterChange)

window.addEventListener('hashchange', () => {
  const requested = readHash()
  if (requested && requested !== state.selectedId) {
    state.selectedId = requested
    renderRunList()
    renderDetailById(requested)
  }
})

boot()
