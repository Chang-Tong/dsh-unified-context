/**
 * Context parity for migrated sessions: make every harness read ONE shared
 * context instead of keeping a copy per harness workspace.
 *
 * The model-visible context is wider than the chat transcript:
 *   1. the conversation itself (imported by plugin/import-service.mjs),
 *   2. instructions — AGENTS.md / CLAUDE.md, global and per project,
 *   3. skills — agent-skill bundles, global and per project,
 *   4. harness-native project config (opencode.json, .claude/settings.json,
 *      WorkBuddy's .workbuddy/settings.json …).
 *
 * This module unifies layers 2 and 3 with symlinks: one real file/directory
 * (the "hub") and one link per harness read-path. Planning is pure and
 * idempotent; applying only creates or replaces symlinks — it never copies or
 * moves content, so an edit made from any harness is immediately visible in
 * all of them and the copies cannot drift apart.
 *
 * Layer 4 is deliberately not migrated: every harness opens the same project
 * directory, so the files already stay in place; only their interpretation is
 * harness-native (documented as a known gap).
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

/** Archive-scale guards so one pathological directory cannot hang a plan. */
const MAX_TREE_ENTRIES = 2000
const MAX_TREE_BYTES = 64 << 20
const MAX_FILE_COMPARE_BYTES = 8 << 20

/** DSH skill names are kebab-case; other harnesses have looser rules, so validate on adoption. */
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Harness-native project config files, reported but never copied. */
export const PROJECT_CONFIG_FILES = [
  'opencode.json',
  'opencode.jsonc',
  '.mcp.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.pi/settings.json',
  '.pi/mcp.json',
  '.codex/config.toml',
  '.workbuddy/settings.json',
  '.workbuddy/settings.local.json',
  '.workbuddy/mcp.json',
  '.codebuddy/settings.json',
  '.codebuddy/settings.local.json',
]

/** Global instruction files, in canonical-adoption priority order. */
const GLOBAL_INSTRUCTION_ADAPTERS = [
  { harness: 'dsh', file: dshHome => join(dshHome, 'AGENTS.md') },
  { harness: 'codex', file: (_dshHome, home) => join(home, '.codex', 'AGENTS.md') },
  { harness: 'claude-code', file: (_dshHome, home) => join(home, '.claude', 'CLAUDE.md') },
  { harness: 'pi', file: (dshHome, home, piAgentRoot) => join(piAgentRoot ?? join(home, '.pi', 'agent'), 'AGENTS.md') },
  {
    harness: 'opencode',
    file: (_dshHome, home, _piAgentRoot, opencodeConfig) => join(opencodeConfig ?? join(home, '.config', 'opencode'), 'AGENTS.md'),
  },
]

/** Global skill roots. `push: true` also receives links to the canonical hub. */
const GLOBAL_SKILL_ROOTS = [
  { harness: 'codex', dir: home => join(home, '.codex', 'skills'), push: true },
  { harness: 'claude-code', dir: home => join(home, '.claude', 'skills'), push: true },
  { harness: 'pi', dir: (home, piAgentRoot) => join(piAgentRoot ?? join(home, '.pi', 'agent'), 'skills'), push: true },
  // WorkBuddy (Tencent) keeps user skills in ~/.workbuddy/skills and does not
  // read ~/.agents/skills, so the hub pushes its bundles into that root.
  { harness: 'workbuddy', dir: home => join(home, '.workbuddy', 'skills'), push: true },
  // opencode natively reads ~/.agents/skills and ~/.claude/skills, so it only
  // contributes skills to the hub; linking hub entries into its own root would
  // load every skill twice.
  { harness: 'opencode', dir: (_home, _pi, opencodeConfig) => join(opencodeConfig ?? join(home(), '.config', 'opencode'), 'skills'), push: false },
  { harness: 'opencode', dir: (_home, _pi, opencodeConfig) => join(opencodeConfig ?? join(home(), '.config', 'opencode'), 'skill'), push: false },
]

/**
 * Resolve the context layout for one machine and (optionally) one project.
 * @param {object} [options] - Path overrides; every path defaults to the usual harness location.
 * @returns {object} layout consumed by {@link planContext}.
 */
export function resolveContextLayout(options = {}) {
  const home = options.home ?? homedir()
  const dshHomeDir = options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh')
  const agentsHomeDir = options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(home, '.agents')
  const piAgentRoot = options.piAgentRoot ?? join(home, '.pi', 'agent')
  const opencodeConfig = options.opencodeConfig ?? join(home, '.config', 'opencode')
  const projectDir = options.projectDir ?? undefined
  // Pull-only by default: every harness contributes to the shared hub and the
  // hub is what dsh reads. `pushSkills: true` additionally links hub skills
  // back into each harness root for full bidirectional parity.
  const pushSkills = options.pushSkills === true

  const instructions = {
    hub: join(agentsHomeDir, 'AGENTS.md'),
    adapters: GLOBAL_INSTRUCTION_ADAPTERS.map(adapter => ({
      harness: adapter.harness,
      path: adapter.file(dshHomeDir, home, piAgentRoot, opencodeConfig),
    })),
  }
  const skills = {
    hub: join(agentsHomeDir, 'skills'),
    roots: GLOBAL_SKILL_ROOTS.map(root => ({
      harness: root.harness,
      path: root.dir(home, piAgentRoot, opencodeConfig),
      push: root.push && pushSkills,
    })),
  }
  return {
    home,
    dshHome: dshHomeDir,
    agentsHome: agentsHomeDir,
    piAgentRoot,
    opencodeConfig,
    projectDir,
    instructions,
    skills,
    project: projectDir === undefined ? undefined : resolveProjectLayout(projectDir, pushSkills),
  }
}

/**
 * Project-level context: one AGENTS.md + one `.agents/skills` shared by every harness.
 * @param {string} projectDir - Absolute project directory.
 */
function resolveProjectLayout(projectDir, pushSkills) {
  return {
    dir: projectDir,
    instructions: {
      agents: join(projectDir, 'AGENTS.md'),
      claude: join(projectDir, 'CLAUDE.md'),
      // WorkBuddy reads CODEBUDDY.md (root) / .codebuddy/CODEBUDDY.md before
      // AGENTS.md; existing files are unified with the canonical instructions.
      codebuddy: join(projectDir, 'CODEBUDDY.md'),
      codebuddyNested: join(projectDir, '.codebuddy', 'CODEBUDDY.md'),
    },
    skills: {
      hub: join(projectDir, '.agents', 'skills'),
      roots: [
        { harness: 'claude-code', path: join(projectDir, '.claude', 'skills'), push: pushSkills },
        { harness: 'codex', path: join(projectDir, '.codex', 'skills'), push: pushSkills },
        { harness: 'pi', path: join(projectDir, '.pi', 'skills'), push: pushSkills },
        { harness: 'workbuddy', path: join(projectDir, '.workbuddy', 'skills'), push: pushSkills },
        { harness: 'workbuddy', path: join(projectDir, '.codebuddy', 'skills'), push: pushSkills },
        // These harnesses read the canonical project dirs themselves.
        { harness: 'opencode', path: join(projectDir, '.opencode', 'skills'), push: false },
        { harness: 'opencode', path: join(projectDir, '.opencode', 'skill'), push: false },
        { harness: 'dsh', path: join(projectDir, '.dsh', 'skills'), push: false },
      ],
    },
    configs: PROJECT_CONFIG_FILES.map(name => join(projectDir, name)),
  }
}

/** Inspect a path without following a final symlink. */
function inspectPath(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return { kind: 'missing' }
  }
  if (stat.isSymbolicLink()) {
    try {
      return { kind: 'symlink', real: realpathSync(path) }
    } catch {
      return { kind: 'broken' }
    }
  }
  try {
    if (stat.isFile()) return { kind: 'file', real: realpathSync(path) }
    if (stat.isDirectory()) return { kind: 'dir', real: realpathSync(path) }
  } catch {
    return { kind: 'other' }
  }
  return { kind: 'other' }
}

/** Human-facing path: `~/…` for home-relative paths. */
function display(path, home) {
  if (path === home) return '~'
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`
  return path
}

/** Sha256 of one readable regular file. */
function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Content signature for a file or a directory tree, bounded by size limits. */
function treeSignature(path, budget = { entries: 0, bytes: 0 }) {
  const stat = statSync(path)
  if (stat.isFile()) {
    if (stat.size > MAX_FILE_COMPARE_BYTES) throw new Error('file too large to compare')
    return `f:${fileDigest(path)}`
  }
  if (!stat.isDirectory()) throw new Error('not a file or directory')
  const parts = []
  for (const name of readdirSync(path).sort()) {
    budget.entries += 1
    if (budget.entries > MAX_TREE_ENTRIES) throw new Error('too many entries to compare')
    const full = join(path, name)
    const leaf = lstatSync(full)
    if (leaf.isSymbolicLink()) {
      parts.push(`${name}:l:${realpathSync(full)}`)
    } else if (leaf.isSymbolicLink() === false && leaf.isDirectory()) {
      parts.push(`${name}:${treeSignature(full, budget)}`)
    } else if (leaf.isFile()) {
      budget.bytes += leaf.size
      if (budget.bytes > MAX_TREE_BYTES) throw new Error('tree too large to compare')
      parts.push(`${name}:f:${fileDigest(full)}`)
    } else {
      parts.push(`${name}:o`)
    }
  }
  return `d:{${parts.join(',')}}`
}

/** Whether two paths currently hold identical file/directory content. */
function sameContent(left, right) {
  try {
    return treeSignature(left) === treeSignature(right)
  } catch {
    return false
  }
}

/** Whether two paths currently hold identical file bytes. */
function sameBytes(left, right) {
  try {
    if (statSync(left).size > MAX_FILE_COMPARE_BYTES) return false
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

/** A path relative to the link's own directory. */
function linkTarget(linkPath, targetPath) {
  return relative(dirname(linkPath), targetPath)
}

/** Skill entries directly inside a root: `<name>/SKILL.md` bundles and flat `<name>.md` files. */
function listSkillEntries(root) {
  const entries = new Map()
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const dirent of dirents) {
    const name = dirent.name
    if (name.startsWith('.')) continue
    const full = join(root, name)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      if (!existsSync(join(full, 'SKILL.md'))) continue
      entries.set(name, { path: full, kind: 'bundle' })
    } else if (stat.isFile() && name.endsWith('.md')) {
      entries.set(name.slice(0, -3), { path: full, kind: 'flat' })
    }
  }
  return entries
}

/** Create-link, adopt-into-hub, or replace-copy-with-link action. */
function linkAction(layer, scope, harness, path, target, reason, mode = 'link') {
  return { layer, scope, harness, mode, path, target, reason }
}

/**
 * Plan instruction links. One real file becomes the hub; every harness path is
 * a symlink to it. Identical existing files are replaced; different files are
 * reported as conflicts and left untouched.
 */
function planInstructions({ hub, adapters, scope, home, notes, conflicts, actions }) {
  const installed = adapters.filter(adapter => {
    const parent = inspectPath(dirname(adapter.path))
    if (parent.kind === 'dir' || parent.kind === 'symlink') return true
    notes.push(`[instructions] ${adapter.harness} is not installed (${display(dirname(adapter.path), home)} missing); skipped`)
    return false
  })
  const present = installed.filter(adapter => inspectPath(adapter.path).kind !== 'missing')
  const hubState = inspectPath(hub)

  // `hubIdentity` is the resolved file content identity; `hubLink` is the
  // logical path new symlinks point at (portable across machines).
  let hubIdentity
  let hubLink
  if (hubState.kind === 'missing') {
    const canonical = present[0]
    if (canonical === undefined) {
      notes.push('[instructions] no global instruction file found; nothing to link')
      return
    }
    hubIdentity = inspectPath(canonical.path).real
    hubLink = canonical.path
    actions.push(linkAction('instructions', scope, 'hub', hub, hubLink, `adopt ${canonical.harness} instructions as the shared hub`, 'adopt'))
  } else if (hubState.kind === 'symlink' || hubState.kind === 'file') {
    hubIdentity = hubState.real
    hubLink = hub
  } else {
    conflicts.push({ layer: 'instructions', scope, harness: 'hub', path: hub, reason: 'hub path exists but is not a file' })
    return
  }
  if (hubIdentity === undefined) return

  for (const adapter of installed) {
    const state = inspectPath(adapter.path)
    const where = display(adapter.path, home)
    if (state.kind === 'missing') {
      actions.push(linkAction('instructions', scope, adapter.harness, adapter.path, hubLink, `share the canonical instructions with ${adapter.harness}`))
      continue
    }
    if (state.kind === 'broken') {
      conflicts.push({ layer: 'instructions', scope, harness: adapter.harness, path: adapter.path, reason: 'dangling symlink; left untouched' })
      continue
    }
    if (state.real === hubIdentity) continue
    if (state.kind === 'symlink') {
      conflicts.push({
        layer: 'instructions',
        scope,
        harness: adapter.harness,
        path: adapter.path,
        reason: `symlink points to ${display(state.real, home)} instead of the hub; left untouched`,
      })
      continue
    }
    if (state.kind !== 'file') {
      conflicts.push({ layer: 'instructions', scope, harness: adapter.harness, path: adapter.path, reason: 'not a regular file; left untouched' })
      continue
    }
    if (sameBytes(adapter.path, hubLink)) {
      actions.push(linkAction('instructions', scope, adapter.harness, adapter.path, hubLink, `identical copy replaced with a link (${where})`, 'replace'))
    } else {
      conflicts.push({
        layer: 'instructions',
        scope,
        harness: adapter.harness,
        path: adapter.path,
        reason: 'different instructions; merge them into the hub and re-run',
      })
    }
  }
}

/**
 * Plan project instruction links: AGENTS.md is canonical, CLAUDE.md becomes a
 * link to it (or the other way round when only CLAUDE.md exists).
 */
function planProjectInstructions(project, scope, home, notes, conflicts, actions) {
  const instructions = project.instructions
  const candidates = [
    // AGENTS.md is the canonical name every harness but Claude Code reads.
    { key: 'agents', path: instructions.agents, create: true },
    { key: 'claude', path: instructions.claude, create: true },
    // WorkBuddy reads CODEBUDDY.md before AGENTS.md: existing ones are unified
    // so both harnesses see the same instructions. Missing ones are not
    // created (WorkBuddy falls back to AGENTS.md on its own).
    { key: 'codebuddy', path: instructions.codebuddy, create: false },
    { key: 'codebuddyNested', path: instructions.codebuddyNested, create: false },
  ]
  const states = new Map(candidates.map(candidate => [candidate.key, inspectPath(candidate.path)]))
  const existing = candidates.filter(candidate => states.get(candidate.key).kind !== 'missing')
  if (existing.length === 0) {
    notes.push('[instructions] project has no AGENTS.md / CLAUDE.md / CODEBUDDY.md; nothing to link')
    return
  }
  const canonical = existing[0]
  const canonicalState = states.get(canonical.key)
  if (canonicalState.kind === 'broken') {
    conflicts.push({ layer: 'instructions', scope, harness: 'project', path: canonical.path, reason: 'dangling symlink; left untouched' })
    return
  }
  if (canonicalState.kind !== 'file' && canonicalState.kind !== 'symlink') {
    conflicts.push({ layer: 'instructions', scope, harness: 'project', path: canonical.path, reason: 'not a regular file; left untouched' })
    return
  }
  const canonicalIdentity = canonicalState.real
  const canonicalLink = canonical.path
  for (const candidate of candidates) {
    if (candidate.key === canonical.key) continue
    const state = states.get(candidate.key)
    if (state.kind === 'missing') {
      if (candidate.create) {
        actions.push(linkAction('instructions', scope, 'project', candidate.path, canonicalLink, 'link the project instruction file under both harness names'))
      }
      continue
    }
    if (state.kind === 'broken') {
      conflicts.push({ layer: 'instructions', scope, harness: 'project', path: candidate.path, reason: 'dangling symlink; left untouched' })
      continue
    }
    if (state.real === canonicalIdentity) continue
    if (state.kind === 'symlink') {
      conflicts.push({ layer: 'instructions', scope, harness: 'project', path: candidate.path, reason: `symlink points to ${display(state.real, home)} instead; left untouched` })
      continue
    }
    if (state.kind !== 'file') {
      conflicts.push({ layer: 'instructions', scope, harness: 'project', path: candidate.path, reason: 'not a regular file; left untouched' })
      continue
    }
    if (sameBytes(candidate.path, canonicalLink)) {
      actions.push(linkAction('instructions', scope, 'project', candidate.path, canonicalLink, 'identical project instructions replaced with a link', 'replace'))
    } else {
      conflicts.push({ layer: 'instructions', scope, harness: 'project', path: candidate.path, reason: 'different project instructions; merge them and re-run' })
    }
  }
}

/**
 * Plan skill convergence for one hub and its harness roots.
 *
 * Invariant: each skill name has exactly one real copy; the hub and every
 * harness root link to it. Skills found only in a harness root are adopted by
 * the hub; identical copies in other roots are replaced with links; different
 * copies are reported as conflicts.
 */
function planSkills({ hub, roots }, scope, home, notes, conflicts, actions) {
  const activeRoots = []
  for (const root of roots) {
    const state = inspectPath(root.path)
    if (state.kind === 'missing') {
      notes.push(`[skills] ${root.harness}: ${display(root.path, home)} not present; skipped`)
      continue
    }
    if (state.kind !== 'dir' && state.kind !== 'symlink') {
      conflicts.push({ layer: 'skills', scope, harness: root.harness, path: root.path, reason: 'not a directory; left untouched' })
      continue
    }
    activeRoots.push(root)
  }

  const hubEntries = listSkillEntries(hub)
  const adopted = new Map()

  // Adopt every harness-only skill into the hub (hub links outward, no copy).
  for (const root of activeRoots) {
    for (const [name, entry] of listSkillEntries(root.path)) {
      if (hubEntries.has(name) || adopted.has(name)) continue
      if (!DSH_SKILL_NAME.test(name)) {
        notes.push(`[skills] ${root.harness}: "${name}" is not a dsh-compatible skill name; left untouched`)
        continue
      }
      const hubPath = join(hub, entry.kind === 'flat' ? `${name}.md` : name)
      const existing = inspectPath(hubPath)
      if (existing.kind !== 'missing') {
        conflicts.push({ layer: 'skills', scope, harness: root.harness, path: hubPath, reason: `hub entry "${name}" exists but is not a skill; left untouched` })
        continue
      }
      const ownerState = inspectPath(entry.path)
      if (ownerState.real === undefined) {
        conflicts.push({ layer: 'skills', scope, harness: root.harness, path: entry.path, reason: 'dangling symlink; left untouched' })
        continue
      }
      actions.push(linkAction('skills', scope, 'hub', hubPath, entry.path, `adopt ${root.harness} skill "${name}" into the shared hub`, 'adopt'))
      adopted.set(name, { hubPath, ownerPath: entry.path, ownerReal: ownerState.real, kind: entry.kind })
    }
  }

  if (hubEntries.size === 0 && adopted.size === 0) {
    if (activeRoots.length > 0) notes.push('[skills] no skill bundles found on either side; nothing to link')
    return
  }

  const names = [...new Set([...hubEntries.keys(), ...adopted.keys()])].sort()
  for (const name of names) {
    const plannedEntry = adopted.get(name)
    const hubEntry = hubEntries.get(name)
    const hubPath = hubEntry?.path ?? plannedEntry?.hubPath ?? join(hub, name)
    const hubState = inspectPath(hubPath)
    let ownerPath
    let ownerReal
    let kind
    if (hubEntries.has(name)) {
      if (hubState.kind === 'broken' || hubState.real === undefined) {
        conflicts.push({ layer: 'skills', scope, harness: 'hub', path: hubPath, reason: 'dangling canonical entry; left untouched' })
        continue
      }
      ownerPath = hubPath
      ownerReal = hubState.real
      kind = hubEntries.get(name).kind
    } else {
      const planned = adopted.get(name)
      if (planned === undefined) continue
      ownerPath = planned.ownerPath
      ownerReal = planned.ownerReal
      kind = planned.kind
    }

    for (const root of activeRoots) {
      const path = join(root.path, name)
      const state = inspectPath(path)
      if (state.kind === 'missing') {
        if (root.push !== true) continue
        if (!DSH_SKILL_NAME.test(name)) continue
        if (kind !== 'bundle') {
          notes.push(`[skills] ${root.harness}: flat skill "${name}" is not pushed (that harness expects a <name>/SKILL.md bundle)`)
          continue
        }
        actions.push(linkAction('skills', scope, root.harness, path, ownerPath, `share the canonical "${name}" skill with ${root.harness}`))
        continue
      }
      if (state.kind === 'broken') {
        conflicts.push({ layer: 'skills', scope, harness: root.harness, path, reason: 'dangling symlink; left untouched' })
        continue
      }
      if (state.real === ownerReal) continue
      const entry = listSkillEntries(root.path).get(name)
      if (entry === undefined) {
        conflicts.push({ layer: 'skills', scope, harness: root.harness, path, reason: `entry "${name}" is not a skill; left untouched` })
        continue
      }
      if (state.kind === 'symlink') {
        conflicts.push({ layer: 'skills', scope, harness: root.harness, path, reason: `symlink points to ${display(state.real, home)} instead of the hub; left untouched` })
        continue
      }
      if (sameContent(path, ownerPath)) {
        actions.push(linkAction('skills', scope, root.harness, path, ownerPath, `identical copy of "${name}" replaced with a link`, 'replace'))
      } else {
        conflicts.push({
          layer: 'skills',
          scope,
          harness: root.harness,
          path,
          reason: `different copy of "${name}"; merge manually and re-run`,
        })
      }
    }
  }
}

/**
 * Build a context-sync plan without touching the filesystem.
 * @param {object} layout - Result of {@link resolveContextLayout}.
 * @param {object} [options] - `{ includeProject?: boolean }`.
 * @returns {{ actions: object[], conflicts: object[], notes: string[], layout: object }}
 */
export function planContext(layout, options = {}) {
  const actions = []
  const conflicts = []
  const notes = []
  const home = layout.home

  planInstructions({
    hub: layout.instructions.hub,
    adapters: layout.instructions.adapters,
    scope: 'global',
    home,
    notes,
    conflicts,
    actions,
  })
  planSkills({ hub: layout.skills.hub, roots: layout.skills.roots }, 'global', home, notes, conflicts, actions)

  if (layout.project !== undefined && options.includeProject !== false) {
    const project = layout.project
    planProjectInstructions(project, 'project', home, notes, conflicts, actions)
    planSkills({ hub: project.skills.hub, roots: project.skills.roots }, 'project', home, notes, conflicts, actions)
    const configs = project.configs.filter(path => inspectPath(path).kind !== 'missing')
    if (configs.length > 0) {
      notes.push(
        `[config] ${configs.map(path => display(path, home)).join(', ')} stay in place — every harness opens the same project directory, so project config is never copied (harness-native formats are not translated)`,
      )
    }
  }

  return { actions, conflicts, notes, layout }
}

/**
 * Apply a plan. Only symlinks are created or replaced; every action is
 * re-validated first, so a concurrent change is skipped instead of clobbered.
 * @param {ReturnType<typeof planContext>} plan - Plan to apply.
 * @returns {{ applied: object[], failed: object[], conflicts: object[], notes: string[] }}
 */
export function applyContextPlan(plan) {
  const applied = []
  const failed = []
  for (const action of plan.actions) {
    try {
      const parent = dirname(action.path)
      mkdirSync(parent, { recursive: true })
      if (action.mode === 'adopt') {
        if (inspectPath(action.path).kind !== 'missing') {
          failed.push({ ...action, error: 'path appeared after planning; skipped' })
          continue
        }
      } else if (action.mode === 'replace') {
        const state = inspectPath(action.path)
        if (state.kind === 'missing') {
          failed.push({ ...action, error: 'path disappeared after planning; skipped' })
          continue
        }
        if (!sameContent(action.path, action.target)) {
          failed.push({ ...action, error: 'content changed after planning; skipped' })
          continue
        }
        rmSync(action.path, { recursive: true, force: true })
      } else {
        const state = inspectPath(action.path)
        if (state.kind !== 'missing') {
          if (state.kind === 'symlink' && state.real === realpathSync(action.target)) continue
          failed.push({ ...action, error: 'path exists after planning; skipped' })
          continue
        }
      }
      symlinkSync(linkTarget(action.path, action.target), action.path)
      applied.push(action)
    } catch (error) {
      failed.push({ ...action, error: error?.message ?? String(error) })
    }
  }
  return { applied, failed, conflicts: plan.conflicts, notes: plan.notes }
}

/** Compact, deterministic rendering shared by the CLI and the slash command. */
export function renderContextPlan(plan, options = {}) {
  const home = options.home ?? plan.layout.home
  const lines = []
  const counts = { link: 0, adopt: 0, replace: 0, conflict: plan.conflicts.length }
  for (const action of plan.actions) counts[action.mode] += 1

  const groups = [
    ['instructions', 'instructions (AGENTS.md / CLAUDE.md)'],
    ['skills', 'skills'],
  ]
  for (const [layer, label] of groups) {
    const layerActions = plan.actions.filter(action => action.layer === layer)
    lines.push(`[${label}] ${layerActions.length === 0 ? 'already shared' : `${layerActions.length} change(s)`}`)
    for (const action of layerActions) {
      const symbol = action.mode === 'adopt' ? '*' : action.mode === 'replace' ? '~' : '+'
      const scope = action.scope === 'project' ? 'project ' : ''
      lines.push(`  ${symbol} ${scope}${display(action.path, home)} -> ${display(action.target, home)}  (${action.reason})`)
    }
  }
  if (plan.conflicts.length > 0) {
    lines.push(`[conflicts] ${plan.conflicts.length} item(s) need a decision:`)
    for (const conflict of plan.conflicts) {
      lines.push(`  ! ${display(conflict.path, home)}: ${conflict.reason}`)
    }
  }
  for (const note of plan.notes) lines.push(note)
  lines.push(
    `[context] plan: ${counts.link} link(s), ${counts.adopt} adopt(s), ${counts.replace} replace(s), ${counts.conflict} conflict(s)`,
  )
  return lines
}

/** Read-only summary of what a harness currently sees; used by tests and `--json`. */
export function describeContext(plan) {
  const home = plan.layout.home
  const sample = (paths) => paths.map(path => ({ path, link: inspectPath(path).kind, target: inspectPath(path).real }))
  const summary = {
    instructions: {
      hub: { path: plan.layout.instructions.hub, ...inspectPath(plan.layout.instructions.hub) },
      adapters: sample(plan.layout.instructions.adapters.map(adapter => adapter.path)),
    },
    skills: {
      hub: { path: plan.layout.skills.hub, ...inspectPath(plan.layout.skills.hub) },
      roots: sample(plan.layout.skills.roots.map(root => root.path)),
    },
  }
  return { ...summary, home, project: plan.layout.projectDir ?? null }
}
