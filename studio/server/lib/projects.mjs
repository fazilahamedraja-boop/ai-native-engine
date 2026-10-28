import fs from 'node:fs'
import path from 'node:path'

import {
  HARNESS_ROOT,
  PROJECTS_ROOT,
  REPO_ROOT,
  StudioError,
  isInside,
  writeJsonAtomic,
} from './studio-paths.mjs'

/**
 * The registry is the only source of project paths, test scripts, executable
 * actions and editable files. A request can name a project and a fixed
 * operation; it can never supply a path or an executable.
 *
 * Two kinds of project live here:
 *  - the built-in reference projects, fixed in this file and rooted inside the
 *    harness directory (they are the Phase 8–19 work and are never written to);
 *  - projects created from a template, which live under `studio/.data/projects`
 *    and carry a `project.manifest.json` written at creation time.
 */

const BUILTIN_PROJECTS = [
  {
    id: 'voxel-sandbox',
    name: 'Voxel Sandbox',
    tagline: 'Procedural block world with mining, building, saving and a browser build.',
    builtIn: true,
    root: 'voxel',
    accent: '#5cc8a1',
    runModes: ['native', 'browser'],
    tests: [
      {
        id: 'voxel-public',
        label: 'Voxel public suite',
        script: 'res://tests/run_voxel_tests.gd',
        timeoutMs: 180000,
        expectedDiagnostics: [
          {
            pattern: '^ERROR: Parse JSON failed\\.',
            whenPassed: 'load-invalid-json-safe',
            max: 1,
            why: 'The invalid-save case loads malformed JSON on purpose to prove the loader fails safely.',
          },
        ],
      },
    ],
    hiddenTest: {
      label: 'Hidden voxel-data acceptance suite',
      relative: 'tests/run_voxel_data_tests.gd',
      script: 'res://tests/run_voxel_data_tests.gd',
      timeoutMs: 120000,
    },
    agent: {
      enabled: true,
      allowedFiles: ['scripts/voxel_data.gd'],
      note: 'The agent may edit only scripts/voxel_data.gd. Tests, scenes, harness files and the canonical project are read-only.',
      maxAttempts: 2,
      timeoutMs: 600000,
      defaultModel: process.env.STUDIO_AGENT_MODEL || 'opencode/deepseek-v4.1-flash-free',
    },
    controls: {
      movement: ['forward', 'strafe', 'jump'],
      actions: [
        { name: 'mine', label: 'Mine' },
        { name: 'place', label: 'Place block' },
        { name: 'save', label: 'Save' },
        { name: 'load', label: 'Load' },
      ],
    },
    smoke: {
      reset: true,
      advanceFrames: 20,
      movementInput: { forward: 1, strafe: 0, jump: false, actions: {} },
      movementFrames: 12,
      positionPath: 'player_position',
    },
    exportPreset: 'Windows Desktop',
    browser: { url: 'http://127.0.0.1:8790/', label: 'Canonical browser build (voxel-web.mjs)' },
  },
  {
    id: 'deflect-arena',
    name: 'Deflect Arena',
    tagline: 'Third-person duel loop with attacks, parries, dodges and enemy AI.',
    builtIn: true,
    root: 'game',
    accent: '#e0a458',
    runModes: ['native'],
    tests: [
      {
        id: 'game-core',
        label: 'Core gameplay suite',
        script: 'res://tests/run_game_tests.gd',
        timeoutMs: 180000,
      },
      {
        id: 'game-dodge',
        label: 'Dodge suite',
        script: 'res://tests/run_dodge_tests.gd',
        timeoutMs: 180000,
      },
    ],
    hiddenTest: null,
    agent: {
      enabled: false,
      allowedFiles: [],
      note: 'Agent tasks are disabled for this project until a bounded editable-file policy and a hidden acceptance suite are configured. Run tests, launch and inspect it normally.',
      maxAttempts: 0,
      timeoutMs: 600000,
      defaultModel: process.env.STUDIO_AGENT_MODEL || 'opencode/deepseek-v4.1-flash-free',
    },
    controls: {
      movement: ['forward', 'strafe'],
      actions: [
        { name: 'attack', label: 'Attack' },
        { name: 'parry', label: 'Parry' },
        { name: 'dodge', label: 'Dodge' },
        { name: 'restart', label: 'Restart' },
      ],
    },
    smoke: null,
    exportPreset: 'Windows Desktop',
    browser: null,
  },
]

/**
 * Templates are the only project types the Studio can actually create. Each one
 * names a built-in project whose tree is copied as the starting point; none of
 * them promise a game type that has no real code behind it.
 */
const TEMPLATES = [
  {
    id: 'voxel-sandbox',
    name: 'Voxel Sandbox',
    label: 'Voxel Sandbox — procedural block world',
    description:
      'A procedurally generated block world with mining, building and saving. Comes with the public suite, the hidden voxel-data suite and windowed smoke runs, so agent tasks are verified end to end.',
    sourceProjectId: 'voxel-sandbox',
    sourcePath: null,
    implemented: true,
    agentEnabled: true,
    editHint: 'The agent may edit only `scripts/voxel_data.gd`.',
    descriptor: null,
  },
  {
    id: 'arena',
    name: '3D Arena Action',
    label: '3D Arena Action — the AI implements the arena',
    description:
      'A readable 3D arena scaffold (camera, sun, floor, on-screen hint) with an honest stub game script. Build Game with AI uses it to implement a playable arena with player, enemy, attacks, health and win/loss, verified by a 20-check acceptance suite.',
    sourceProjectId: null,
    sourcePath: 'studio/templates/arena',
    implemented: true,
    agentEnabled: true,
    editHint:
      'The agent may edit `scripts/main.gd`, add scripts under `scripts/`, and edit scenes under `scenes/` (plus `assets/` if it adds art). Tests, harness files and project settings are read-only.',
    descriptor: {
      accent: '#e0a458',
      runModes: ['native'],
      tests: [
        {
          id: 'arena-acceptance',
          label: 'Arena acceptance suite',
          script: 'res://tests/run_arena_tests.gd',
          timeoutMs: 180000,
          // The scaffold cannot pass this suite by design; the baseline only has
          // to prove that the untouched project parses and launches.
          baseline: false,
        },
      ],
      hiddenTest: {
        label: 'Pristine arena acceptance suite',
        relative: 'tests/run_arena_tests.gd',
        script: 'res://tests/run_arena_tests.gd',
        sourcePath: 'studio/templates/arena/tests/run_arena_tests.gd',
        visibleInProject: true,
        timeoutMs: 180000,
      },
      agent: {
        enabled: true,
        allowedFiles: ['scripts/main.gd'],
        allowedPatterns: ['scripts/**/*.gd', 'scripts/**/*.tscn', 'scenes/**', 'assets/**'],
        allowAdditions: true,
        protectedPaths: [
          'tests/**',
          'harness/**',
          'scripts/arena_host.gd',
          'project.godot',
          'export_presets.cfg',
          'ARENA_SPEC.md',
          'README.md',
          'PROJECT.md',
          'project.manifest.json',
          '.studio-hidden/**',
          'opencode.json',
          'TASK.md',
          'STUDIO_FAILURE.md',
        ],
        note: 'The agent implements the arena in scripts/main.gd and may add scripts, scenes and assets. Tests, harness files, the host and project settings stay read-only, and every candidate is verified before you can approve it.',
        maxAttempts: 3,
        timeoutMs: 900000,
        defaultModel: process.env.STUDIO_AGENT_MODEL || 'opencode/deepseek-v4.1-flash-free',
      },
      controls: {
        movement: ['forward', 'back', 'left', 'right'],
        actions: [
          { name: 'attack', label: 'Attack' },
          { name: 'restart', label: 'Restart' },
        ],
      },
      smoke: {
        reset: true,
        advanceFrames: 20,
        movementInput: { forward: 1 },
        movementFrames: 30,
        positionPath: 'player_position',
      },
      exportPreset: null,
    },
  },
]

function templateSourceDir(template, harnessRoot) {
  if (template.sourceProjectId) {
    return path.resolve(harnessRoot, builtinById(template.sourceProjectId).root)
  }
  const resolved = path.resolve(REPO_ROOT, template.sourcePath)
  if (!isInside(resolved, path.join(REPO_ROOT, 'studio', 'templates'))) {
    throw new StudioError('template_missing', 'A template must live under studio/templates.', 500)
  }
  return resolved
}

export const MAX_CREATED_PROJECTS = 20
const MANIFEST_NAME = 'project.manifest.json'
const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,46}[A-Za-z0-9])?$/
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])
// Godot's import cache is regenerated on first open; copying it would only add
// machine-specific noise (and its internal paths point back at the template).
const COPY_EXCLUDE = new Set(['.godot', 'artifacts', MANIFEST_NAME])

export function listTemplates() {
  return TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    label: template.label,
    description: template.description,
    implemented: template.implemented,
    agentEnabled: template.agentEnabled,
  }))
}

function templateById(templateId) {
  const template = TEMPLATES.find((entry) => entry.id === templateId)
  if (!template) {
    throw new StudioError(
      'invalid_template',
      `Unknown template "${String(templateId).slice(0, 40)}". The only implemented template is ${TEMPLATES.map((entry) => entry.id).join(', ')}.`,
      400,
    )
  }
  return template
}

function builtinById(projectId) {
  return BUILTIN_PROJECTS.find((entry) => entry.id === projectId) ?? null
}

export function slugifyProjectName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

function displayPath(absolute) {
  return isInside(absolute, REPO_ROOT)
    ? path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
    : absolute.split(path.sep).join('/')
}

function assertValidName(rawName) {
  const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 2 || name.length > 48) {
    throw new StudioError('invalid_project_name', 'Give the project a name of 2–48 characters.', 400)
  }
  if (name.includes('..') || /[/\\]/.test(name) || /[\u0000-\u001f]/.test(name)) {
    throw new StudioError(
      'invalid_project_name',
      'A project name cannot contain slashes, "..", or control characters.',
      400,
    )
  }
  if (!NAME_RE.test(name)) {
    throw new StudioError(
      'invalid_project_name',
      'Use letters, numbers, spaces, dots, dashes and underscores. The name must start and end with a letter or number.',
      400,
    )
  }
  const slug = slugifyProjectName(name)
  if (slug.length < 2) {
    throw new StudioError('invalid_project_name', 'That name has no usable letters or numbers.', 400)
  }
  if (RESERVED_NAMES.has(slug)) {
    throw new StudioError('invalid_project_name', `"${name}" is a reserved device name.`, 400)
  }
  return { name, slug }
}

/** Copy a template tree, skipping the import cache and generated captures. */
function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (COPY_EXCLUDE.has(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyTree(from, to)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

/**
 * Give the copy its own window/application name. Only the copied file is
 * touched; the template is read-only.
 */
function renameProject(dir, name) {
  const file = path.join(dir, 'project.godot')
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  const next = text.replace(/^config\/name=.*$/m, `config/name=${JSON.stringify(name)}`)
  if (next !== text) fs.writeFileSync(file, next, 'utf8')
}

function writeProjectDocs({ dir, name, template, description, createdAt }) {
  const body = [
    `# ${name}`,
    '',
    description || 'Created in the AI Game Studio.',
    '',
    `- Template: ${template.name} (\`${template.id}\`)`,
    `- Created: ${createdAt}`,
    '',
    'This project was generated by the AI Game Studio into `studio/.data/projects`.',
    template.editHint ??
      `The agent may edit only ${template.descriptor?.agent?.allowedFiles?.map((file) => `\`${file}\``).join(', ') ?? 'the files named in the template'}; tests and project settings are read-only, and every candidate is verified before you can approve it.`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, 'PROJECT.md'), body, 'utf8')
}

/**
 * Prepare the Godot import cache (including the global script class cache) in a
 * freshly copied project. Without it, `class_name` lookups fail until something
 * opens the project in the editor, so the first launch would break.
 *
 * The import helper lives in the runner (it also prepares agent workspaces).
 * It is imported dynamically because the runner in turn imports this module.
 */
async function defaultInitializeProject(projectDir) {
  const { prepareWorkspaceImports } = await import('./agent-runner.mjs')
  const result = await prepareWorkspaceImports({ projectDir })
  return {
    ok: Boolean(result.ok),
    code: result.code ?? null,
    message: result.message,
    durationMs: result.durationMs ?? null,
  }
}

export function createProjectRegistry({
  projectsRoot = PROJECTS_ROOT,
  harnessRoot = HARNESS_ROOT,
  maxProjects = MAX_CREATED_PROJECTS,
  now = () => new Date(),
  initializeProject = defaultInitializeProject,
} = {}) {
  const root = path.resolve(projectsRoot)

  function createdDirs() {
    if (!fs.existsSync(root)) return []
    const dirs = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !PROJECT_ID_RE.test(entry.name)) {
        continue
      }
      dirs.push(path.join(root, entry.name))
    }
    return dirs
  }

  function readManifest(dir) {
    const file = path.join(dir, MANIFEST_NAME)
    if (!fs.existsSync(file)) return null
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      throw new StudioError(
        'corrupted_project',
        `The manifest for "${path.basename(dir)}" is not valid JSON.`,
        409,
      )
    }
  }

  function descriptorFromManifest(dir, manifest) {
    const template = TEMPLATES.find((entry) => entry.id === manifest.template) ?? null
    const source = template ? builtinById(template.sourceProjectId) : null
    // A template either borrows the gameplay descriptor of a built-in project
    // (voxel) or carries its own (arena, whose tree lives in studio/templates).
    const spec = template?.descriptor ?? source
    const id = path.basename(dir)
    return {
      id,
      name: manifest.name,
      tagline: manifest.description || (source ? source.tagline : 'A project created in the Studio.'),
      accent: spec?.accent ?? '#7aa2f7',
      builtIn: false,
      created: true,
      templateId: manifest.template ?? null,
      templateName: template?.name ?? null,
      createdAt: manifest.createdAt ?? null,
      initializedAt: manifest.initializedAt ?? null,
      initialization: manifest.initialization ?? null,
      manifestStatus: manifest.status ?? 'ready',
      dir: id,
      runModes: spec ? spec.runModes.filter((mode) => mode !== 'browser') : ['native'],
      tests: spec ? spec.tests.map((test) => ({ ...test })) : [],
      hiddenTest: spec?.hiddenTest ? { ...spec.hiddenTest } : null,
      agent: spec
        ? {
            ...spec.agent,
            note: `Created from the ${template?.name ?? 'template'} template. ${spec.agent.note}`,
          }
        : {
            enabled: false,
            allowedFiles: [],
            note: 'This project has no matching template, so agent tasks are disabled. Tests and launch still work.',
            maxAttempts: 0,
            timeoutMs: 600000,
            defaultModel: process.env.STUDIO_AGENT_MODEL || 'opencode/deepseek-v4.1-flash-free',
          },
      controls: spec?.controls ?? { movement: [], actions: [] },
      smoke: spec?.smoke ? { ...spec.smoke } : null,
      exportPreset: spec?.exportPreset ?? null,
      // A browser build has to be exported and served per project; creation does
      // not do that, so the preview is honestly absent instead of faked.
      browser: null,
    }
  }

  function listCreated() {
    const created = []
    for (const dir of createdDirs()) {
      let manifest
      try {
        manifest = readManifest(dir)
      } catch {
        // A broken manifest is reported by get(); listing skips it so one bad
        // directory cannot hide every other project.
        continue
      }
      if (!manifest || manifest.id !== path.basename(dir)) continue
      created.push(descriptorFromManifest(dir, manifest))
    }
    created.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    return created
  }

  function list() {
    return [
      ...BUILTIN_PROJECTS.map((project) => ({ ...project })),
      ...listCreated(),
    ]
  }

  function get(projectId) {
    if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
      throw new StudioError('invalid_project', 'Unknown project id.', 400)
    }
    const builtIn = builtinById(projectId)
    if (builtIn) return { ...builtIn }
    const dir = path.join(root, projectId)
    if (!isInside(dir, root) || !fs.existsSync(dir)) {
      throw new StudioError('invalid_project', `No registered project with id "${projectId}".`, 404)
    }
    const manifest = readManifest(dir)
    if (!manifest || manifest.id !== projectId) {
      throw new StudioError(
        'corrupted_project',
        `The project directory "${projectId}" has no matching manifest.`,
        409,
      )
    }
    return descriptorFromManifest(dir, manifest)
  }

  function rootOf(project) {
    if (project.builtIn) {
      const absolute = path.resolve(harnessRoot, project.root)
      if (!isInside(absolute, harnessRoot)) {
        throw new StudioError('path_outside_root', 'Project root escaped the harness directory.', 500)
      }
      return absolute
    }
    if (typeof project.dir !== 'string' || !PROJECT_ID_RE.test(project.dir)) {
      throw new StudioError('path_outside_root', 'Created project has an invalid directory.', 500)
    }
    const absolute = path.resolve(root, project.dir)
    if (!isInside(absolute, root)) {
      throw new StudioError('path_outside_root', 'Project root escaped the projects directory.', 500)
    }
    return absolute
  }

  function exportPresetFileOf(project) {
    return path.join(rootOf(project), 'export_presets.cfg')
  }

  function status(project, { runtime = null, lastOps = [] } = {}) {
    const absolute = rootOf(project)
    const exists = fs.existsSync(absolute)
    // Ready means Godot has actually imported the project: the global script
    // class cache is what makes `class_name` lookups resolve at runtime. An
    // empty `.godot` directory from a failed launch is not enough.
    const hasImportCache = fs.existsSync(path.join(absolute, '.godot', 'global_script_class_cache.cfg'))
    const hasExportPreset =
      project.exportPreset !== null &&
      fs.existsSync(exportPresetFileOf(project)) &&
      fs.readFileSync(exportPresetFileOf(project), 'utf8').includes(`name="${project.exportPreset}"`)
    const lastByKey = new Map(lastOps.map((entry) => [entry.key, entry]))
    return {
      id: project.id,
      name: project.name,
      tagline: project.tagline,
      accent: project.accent,
      path: displayPath(absolute),
      absolutePath: absolute,
      created: Boolean(project.created),
      templateId: project.templateId ?? null,
      templateName: project.templateName ?? null,
      createdAt: project.createdAt ?? null,
      initializedAt: project.initializedAt ?? null,
      initialization: project.initialization ?? null,
      manifestStatus: project.manifestStatus ?? null,
      runModes: project.runModes,
      tests: project.tests.map((test) => ({
        id: test.id,
        label: test.label,
        script: test.script,
        last: lastByKey.get(`${project.id}:test:${test.id}`) ?? null,
      })),
      hiddenTest: project.hiddenTest
        ? { label: project.hiddenTest.label, relative: project.hiddenTest.relative }
        : null,
      agent: {
        enabled: project.agent.enabled,
        allowedFiles: project.agent.allowedFiles,
        allowedPatterns: project.agent.allowedPatterns ?? [],
        note: project.agent.note,
        maxAttempts: project.agent.maxAttempts,
        defaultModel: project.agent.defaultModel,
      },
      controls: project.controls,
      exportPreset: project.exportPreset,
      browser: project.browser,
      status: {
        exists,
        hasImportCache,
        hasExportPreset,
        runtime: runtime
          ? {
              running: runtime.running,
              pid: runtime.pid,
              startedAt: runtime.startedAt,
              headless: runtime.headless,
            }
          : { running: false, pid: null, startedAt: null, headless: null },
        ready: exists && hasImportCache,
      },
    }
  }

  function entryPath(entry) {
    return path.join(root, entry.name)
  }

  /** Remove staging directories from a crash mid-copy, so they cannot pile up. */
  function sweepStaging() {
    if (!fs.existsSync(root)) return
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.creating-')) continue
      const dir = entryPath(entry)
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // Cleanup is best effort; a locked staging directory is harmless.
      }
    }
  }

  async function create({ name: rawName, templateId, description = '' } = {}) {
    const template = templateById(templateId)
    const { name, slug } = assertValidName(rawName)
    const text = typeof description === 'string' ? description.trim() : ''
    if (text.length > 600) {
      throw new StudioError('invalid_description', 'Keep the description under 600 characters.', 400)
    }

    sweepStaging()

    const existing = list()
    const duplicate = existing.find(
      (project) => project.id === slug || project.name.toLowerCase() === name.toLowerCase(),
    )
    if (duplicate) {
      throw new StudioError(
        'project_exists',
        `A project called "${duplicate.name}" already exists. Pick a different name.`,
        409,
      )
    }
    const target = path.join(root, slug)
    if (!isInside(target, root)) {
      throw new StudioError('invalid_project_name', 'That name escapes the projects directory.', 400)
    }
    if (fs.existsSync(target)) {
      throw new StudioError('project_exists', `"${slug}" already exists on disk.`, 409)
    }
    const createdCount = createdDirs().filter((dir) => fs.existsSync(path.join(dir, MANIFEST_NAME)))
    if (createdCount.length >= maxProjects) {
      throw new StudioError(
        'project_limit',
        `The Studio holds at most ${maxProjects} created projects. Remove one before creating another.`,
        409,
      )
    }

    const source = templateSourceDir(template, harnessRoot)
    if (!fs.existsSync(source)) {
      throw new StudioError(
        'template_missing',
        `The ${template.name} template is not available on this machine (${displayPath(source)}).`,
        500,
      )
    }

    fs.mkdirSync(root, { recursive: true })
    const createdAt = now().toISOString()
    const staging = path.join(root, `.creating-${slug}-${process.pid}`)
    fs.rmSync(staging, { recursive: true, force: true })
    try {
      copyTree(source, staging)
      renameProject(staging, name)
      const manifest = {
        schema: 'studio.project.v1',
        id: slug,
        name,
        template: template.id,
        description: text,
        createdAt,
        status: 'initializing',
      }
      writeJsonAtomic(path.join(staging, MANIFEST_NAME), manifest)
      writeProjectDocs({ dir: staging, name, template, description: text, createdAt })
      try {
        // rename fails if the target exists, which is the duplicate guard that
        // also covers two simultaneous requests for the same name.
        fs.renameSync(staging, target)
      } catch (error) {
        if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'ENOTEMPTY') {
          throw new StudioError('project_exists', `"${slug}" already exists.`, 409)
        }
        throw error
      }

      // Initialise the copy for real: Godot imports the assets and writes the
      // global script class cache the game needs to resolve `class_name` types.
      // A failed import keeps the project (nothing is lost) but records the
      // failure in the manifest so the UI can explain it instead of pretending
      // the project is ready.
      const initialization = await initializeProject(target)
      const initializedAt = now().toISOString()
      const manifestAfter = {
        ...manifest,
        status: initialization.ok ? 'ready' : 'needs_import',
        initializedAt,
        initialization: {
          ok: Boolean(initialization.ok),
          message: initialization.message ?? '',
          durationMs: initialization.durationMs ?? null,
        },
      }
      writeJsonAtomic(path.join(target, MANIFEST_NAME), manifestAfter)
      return get(slug)
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    }
  }

  return {
    projectsRoot: root,
    list,
    get,
    rootOf,
    status,
    exportPresetFile: exportPresetFileOf,
    templates: listTemplates,
    create,
  }
}

/** The process-wide registry used by the server, jobs and operations. */
export const projects = createProjectRegistry()

export function listRegisteredProjects() {
  return projects.list()
}

export function getProject(projectId) {
  return projects.get(projectId)
}

export function projectRoot(project) {
  return projects.rootOf(project)
}

export function exportPresetFile(project) {
  return projects.exportPresetFile(project)
}

export function projectStatus(project, options = {}) {
  return projects.status(project, options)
}

export function createProject(input) {
  return projects.create(input)
}
