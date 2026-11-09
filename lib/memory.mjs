/**
 * Long-term memory parity for migrated projects.
 *
 * Memory is a separate layer from instructions and sessions:
 *   - project memory: Claude Code's `~/.claude/projects/<encoded>/memory/`
 *     directory and WorkBuddy's `<project>/.workbuddy/memory/` directory.
 *     Codex has no per-project memory store (its project memory is AGENTS.md).
 *   - agent memory: Codex/Claude `agent-memory/<agent>/` directories. This is
 *     per agent, not per project, so it is unified at the agent level using
 *     Codex's layout as the model.
 *
 * Policy (default `authority`, or opt-in `merge` / `off`):
 *   - authority: one canonical directory per scope (project: `.agents/memory/`,
 *     agent: `~/.agents/agent-memory/<agent>/`); other harness paths become
 *     symlinks to it. Divergent content is reported, never overwritten.
 *   - merge: `<project>/.agents/memory/MEMORY.md` becomes a generated *index*
 *     that references every harness's memory note in place — no copies, no
 *     directory replacement.
 *   - off: leave memory untouched.
 *
 * dsh has no independent memory reader, so the project's shared index also
 * appears as a small marked block inside the project AGENTS.md (the one file
 * every harness reads); notes stay on disk and are read on demand.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

import { readFirstLine } from './lines.mjs'

const BLOCK_BEGIN = '<!-- dsh-unified-context:memory:begin -->'
const BLOCK_END = '<!-- dsh-unified-context:memory:end -->'
const BLOCK_RE = /<!-- dsh-unified-context:memory:begin -->[\s\S]*?<!-- dsh-unified-context:memory:end -->/u
const MAX_INDEX_ENTRIES = 20
const MAX_MERGE_ENTRIES = 200
const MAX_NOTE_BYTES = 4 << 20

const PROJECT_AUTHORITY_ORDER = ['claude-code', 'workbuddy']
const AGENT_AUTHORITY_ORDER = ['codex', 'claude-code']

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
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

/** A path relative to the link's own directory. */
function linkTarget(linkPath, targetPath) {
  return relative(dirname(linkPath), targetPath)
}

/** Whether a directory exists and has no entries. */
function isEmptyDir(path) {
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0
  } catch {
    return false
  }
}

/** Content signature for a note directory (files and symlinks, bounded). */
function treeSignature(path, budget = { entries: 0 }) {
  const stat = statSync(path)
  if (stat.isFile()) return `f:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
  if (!stat.isDirectory()) throw new Error('not a file or directory')
  const parts = []
  for (const name of readdirSync(path).sort()) {
    budget.entries += 1
    if (budget.entries > 500) throw new Error('too many entries to compare')
    const full = join(path, name)
    const leaf = lstatSync(full)
    if (leaf.isSymbolicLink()) parts.push(`${name}:l:${realpathSync(full)}`)
    else if (leaf.isDirectory()) parts.push(`${name}:${treeSignature(full, budget)}`)
    else if (leaf.isFile()) parts.push(`${name}:f:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    else parts.push(`${name}:o`)
  }
  return `d:{${parts.join(',')}}`
}

/** Whether two directories hold identical content. */
function sameContent(left, right) {
  try {
    return treeSignature(left) === treeSignature(right)
  } catch {
    return false
  }
}

/** Hash of one file's current content, or undefined when absent. */
function fileHash(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/** Parse a memory note's title/description from frontmatter or its first body line. */
function parseNote(path) {
  let text = ''
  try {
    if (statSync(path).size > MAX_NOTE_BYTES) return { title: basename(path, '.md'), description: '' }
    text = readFileSync(path, 'utf8')
  } catch {
    return { title: basename(path, '.md'), description: '' }
  }
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)
  let title
  let description
  if (frontmatter !== null) {
    title = /^name:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim()
    description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim()
  }
  if (description === undefined || description.length === 0) {
    const body = frontmatter === null ? text : text.slice(frontmatter[0].length)
    const line = body.split(/\r?\n/u).find(candidate => candidate.trim().length > 0 && !candidate.trim().startsWith('#'))
    if (line !== undefined) description = line.trim().slice(0, 160)
  }
  return { title: title !== undefined && title.length > 0 ? title : basename(path, '.md'), description: description ?? '' }
}

/** List memory notes in a directory (up to two levels deep; MEMORY.md is the index). */
function listMemoryNotes(dir, max = MAX_MERGE_ENTRIES) {
  const notes = []
  const walk = (current, prefix, level) => {
    if (notes.length >= max || level > 2) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (notes.length >= max) return
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, rel, level + 1)
      } else if (stat.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md') {
        notes.push({ path: full, rel, ...parseNote(full) })
      }
    }
  }
  walk(dir, '', 0)
  return notes
}

/** Find Claude Code's memory directory for one project by matching a session cwd. */
export function findClaudeProjectMemory(home, projectDir) {
  const root = join(home, '.claude', 'projects')
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const wanted = normalizeProjectPath(projectDir)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectKeyDir = join(root, entry.name)
    const cwd = readClaudeProjectCwd(projectKeyDir)
    if (cwd === undefined || normalizeProjectPath(cwd) !== wanted) continue
    return { projectDir: projectKeyDir, memory: join(projectKeyDir, 'memory') }
  }
  return undefined
}

/** Read the cwd recorded by the first session file in a Claude project directory. */
function readClaudeProjectCwd(projectKeyDir) {
  let files
  try {
    files = readdirSync(projectKeyDir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const file of files.slice(0, 5)) {
    if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
    try {
      const first = JSON.parse(readFirstLine(join(projectKeyDir, file.name)))
      if (typeof first.cwd === 'string') return first.cwd
    } catch {
      // Try the next session file.
    }
  }
  return undefined
}

/** Compare project paths after resolving symlinks when possible. */
function normalizeProjectPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path.replace(/\/+$/u, '')
  }
}

/**
 * Resolve memory locations for this machine and (optionally) one project.
 * @param {object} [options] - Path overrides.
 * @returns {object} layout consumed by {@link planMemory}.
 */
export function resolveMemoryLayout(options = {}) {
  const home = options.home ?? homedir()
  const agentsHome = options.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(home, '.agents')
  const projectDir = options.projectDir
  const agents = {
    canonicalRoot: join(agentsHome, 'agent-memory'),
    sources: [
      { harness: 'codex', root: join(home, '.codex', 'agent-memory') },
      { harness: 'claude-code', root: join(home, '.claude', 'agent-memory') },
    ],
  }
  if (projectDir === undefined) return { home, agentsHome, projectDir, project: undefined, agents }
  const project = resolveProjectMemoryLayout(home, projectDir)
  return { home, agentsHome, projectDir, project, agents }
}

/** Project-scope memory adapters: Claude (matched project dir) + WorkBuddy. */
function resolveProjectMemoryLayout(home, projectDir) {
  const adapters = []
  const claude = findClaudeProjectMemory(home, projectDir)
  if (claude !== undefined) {
    adapters.push({ harness: 'claude-code', path: claude.memory, parent: claude.projectDir, exists: existsSync(claude.memory) })
  }
  const workbuddyParent = join(projectDir, '.workbuddy')
  adapters.push({
    harness: 'workbuddy',
    path: join(workbuddyParent, 'memory'),
    parent: workbuddyParent,
    exists: existsSync(join(workbuddyParent, 'memory')),
  })
  return {
    dir: projectDir,
    canonical: join(projectDir, '.agents', 'memory'),
    instructions: join(projectDir, 'AGENTS.md'),
    adapters,
  }
}

/** Pick the source that should own the canonical directory. */
function chooseAuthority(sources, priority, requested) {
  const order = requested !== undefined ? [requested, ...priority.filter(harness => harness !== requested)] : priority
  for (const harness of order) {
    for (const source of sources) {
      if (source.harness === harness && !isEmptyDir(source.path)) return source
    }
  }
  for (const source of sources) {
    if (!isEmptyDir(source.path)) return source
  }
  return sources[0]
}

/**
 * Plan one directory family (project memory or one scope of agent memory).
 * The canonical copy is adopted from (or owned by) the authority source; every
 * other harness directory becomes a symlink. Divergent content is a conflict.
 */
function planDirectoryFamily({ canonical, sources, scope, priority, requested, home, actions, conflicts, notes, createCanonical }) {
  const active = sources.filter((source) => {
    const state = inspectPath(source.path)
    return state.kind === 'dir' || state.kind === 'symlink' || (source.parent !== undefined && existsSync(source.parent))
  })
  if (active.length === 0) {
    notes.push(`[memory] ${scope}: no harness memory directory found; nothing to link`)
    return
  }
  const canonicalState = inspectPath(canonical)
  let identity
  let canonicalLink = canonical
  if (canonicalState.kind === 'missing') {
    if (requested === 'dsh' && createCanonical === true) {
      actions.push({ mode: 'mkdir', scope, harness: 'dsh', path: canonical, reason: 'own the shared memory directory in .agents (authority: dsh)' })
      identity = canonical
    } else {
      const authority = chooseAuthority(active.filter(source => inspectPath(source.path).kind !== 'missing'), priority, requested)
      if (authority === undefined) {
        notes.push(`[memory] ${scope}: no existing memory source; nothing to link`)
        return
      }
      actions.push({
        mode: 'adopt',
        scope,
        harness: authority.harness,
        path: canonical,
        target: authority.path,
        reason: `adopt ${authority.harness} ${scope} memory as the shared directory`,
      })
      identity = inspectPath(authority.path).real
      canonicalLink = authority.path
    }
  } else if (canonicalState.kind === 'symlink' || canonicalState.kind === 'dir') {
    identity = canonicalState.real
  } else {
    conflicts.push({ scope, harness: 'hub', path: canonical, reason: 'canonical memory path exists but is not a directory' })
    return
  }
  if (identity === undefined) return

  for (const source of active) {
    const state = inspectPath(source.path)
    if (state.kind === 'missing') {
      if (source.parent !== undefined && existsSync(source.parent)) {
        actions.push({
          mode: 'link',
          scope,
          harness: source.harness,
          path: source.path,
          target: canonicalLink,
          reason: `share the ${scope} memory directory with ${source.harness}`,
        })
      } else {
        notes.push(`[memory] ${scope}: ${source.harness} memory directory not present; skipped`)
      }
      continue
    }
    if (state.kind === 'broken') {
      conflicts.push({ scope, harness: source.harness, path: source.path, reason: 'dangling symlink; left untouched' })
      continue
    }
    if (state.real === identity) continue
    if (state.kind === 'symlink') {
      conflicts.push({
        scope,
        harness: source.harness,
        path: source.path,
        reason: `symlink points to ${display(state.real, home)} instead of the shared directory; left untouched`,
      })
      continue
    }
    if (state.kind !== 'dir') {
      conflicts.push({ scope, harness: source.harness, path: source.path, reason: 'not a directory; left untouched' })
      continue
    }
    if (source.path === canonicalLink) continue
    const empty = isEmptyDir(source.path)
    if (empty || sameContent(source.path, canonicalLink)) {
      actions.push({
        mode: 'replace',
        scope,
        harness: source.harness,
        path: source.path,
        target: canonicalLink,
        empty,
        reason: empty ? 'empty directory replaced with a link' : 'identical copy replaced with a link',
      })
      continue
    }
    conflicts.push({
      scope,
      harness: source.harness,
      path: source.path,
      reason: `different ${scope} memory; use --authority=${source.harness} or --memory=merge`,
    })
  }
}

/** Render the small AGENTS.md block for project memory. */
function renderProjectBlock(project, mode, _home, _notes, available = true, memoryDir = project.canonical) {
  if (mode === 'merge') {
    if (!available) return ''
    return [
      BLOCK_BEGIN,
      '## Project memory',
      '',
      'Merged memory index: [`.agents/memory/MEMORY.md`](.agents/memory/MEMORY.md) — references each harness memory note in place (no copies). Read notes on demand.',
      BLOCK_END,
    ].join('\n')
  }
  const entries = existsSync(memoryDir) ? listMemoryNotes(memoryDir) : []
  if (entries.length === 0) return ''
  const lines = [
    BLOCK_BEGIN,
    '## Project memory',
    '',
    'Shared memory directory `.agents/memory/` — one copy, read by Claude Code / WorkBuddy through the same directory. Read notes on demand:',
    '',
  ]
  if (existsSync(join(memoryDir, 'MEMORY.md'))) lines.push('- [`MEMORY.md`](.agents/memory/MEMORY.md) — memory index')
  for (const note of entries.slice(0, MAX_INDEX_ENTRIES)) {
    lines.push(`- [${escapeMd(note.title)}](.agents/memory/${note.rel})${note.description.length > 0 ? ` — ${escapeMd(note.description)}` : ''}`)
  }
  if (entries.length > MAX_INDEX_ENTRIES) lines.push(`- … and ${entries.length - MAX_INDEX_ENTRIES} more note(s)`)
  lines.push(BLOCK_END)
  return lines.join('\n')
}

/** Escape the characters that would break a Markdown link label. */
function escapeMd(text) {
  return text.replace(/[[\]]/gu, '\\$&')
}

/** Insert or replace the generated memory block in an AGENTS.md text. */
function upsertBlock(text, block) {
  if (block.length === 0) {
    if (!BLOCK_RE.test(text)) return text
    return text.replace(BLOCK_RE, '').replace(/\n{3,}/gu, '\n\n').trimEnd() + '\n'
  }
  if (BLOCK_RE.test(text)) return text.replace(BLOCK_RE, block)
  return `${text.trimEnd()}\n\n${block}\n`
}

/** Plan the generated instruction-file index (dsh reads AGENTS.md). */
function planProjectIndex(project, mode, actions, notes) {
  if (project.instructions === undefined) return
  const index = join(project.canonical, 'MEMORY.md')
  if (mode === 'merge') {
    const mergeIndexPlanned = existsSync(index) || actions.some(action => action.path === index)
    const block = renderProjectBlock(project, mode, '', notes, mergeIndexPlanned, project.canonical)
    if (block.length === 0) return
    planIndexWrite(project, block, actions, notes)
    return
  }
  const adopted = actions.find(action => action.mode === 'adopt' && action.path === project.canonical)
  const memoryDir = existsSync(project.canonical) ? project.canonical : adopted?.target
  if (memoryDir === undefined || !existsSync(memoryDir)) return
  const block = renderProjectBlock(project, mode, '', notes, true, memoryDir)
  if (block.length === 0) return
  planIndexWrite(project, block, actions, notes)
}

/** Write/refresh the marked block inside the project instruction file. */
function planIndexWrite(project, block, actions, notes) {
  const state = inspectPath(project.instructions)
  if (state.kind === 'missing') {
    if (block.length === 0) return
    actions.push({
      mode: 'create',
      scope: 'project',
      harness: 'dsh',
      path: project.instructions,
      writePath: project.instructions,
      content: `# AGENTS.md\n\n${block}\n`,
      previous: undefined,
      reason: 'create AGENTS.md with the shared project-memory index',
    })
    return
  }
  const writePath = state.kind === 'symlink' ? state.real : project.instructions
  const previous = fileHash(writePath)
  let text = ''
  try {
    text = readFileSync(writePath, 'utf8')
  } catch {
    notes.push('[memory] could not read project AGENTS.md; memory index not written')
    return
  }
  const next = upsertBlock(text, block)
  if (next === text) return
  actions.push({
    mode: 'write',
    scope: 'project',
    harness: 'dsh',
    path: project.instructions,
    writePath,
    content: next,
    previous,
    reason: block.length > 0 ? 'add/refresh the shared project-memory index in AGENTS.md' : 'remove the project-memory index from AGENTS.md',
  })
}

/** Plan the generated merged index (references notes in place; no copies). */
function planMergedIndex(project, home, actions, notes, conflicts) {
  const sources = []
  for (const adapter of project.adapters) {
    if (!existsSync(adapter.path)) continue
    sources.push({ harness: adapter.harness, dir: adapter.path, entries: listMemoryNotes(adapter.path) })
  }
  const canonicalNotes = existsSync(project.canonical) ? listMemoryNotes(project.canonical) : []
  for (const source of sources) {
    for (const note of source.entries) note.description = note.description.length > 0 ? note.description : note.title
  }
  if (sources.every(source => source.entries.length === 0) && canonicalNotes.length === 0) {
    notes.push('[memory] merge: no memory notes found; nothing to index')
  }
  const lines = [
    '<!-- generated by dsh-unified-context; re-run /link-context --memory=merge to refresh; manual edits are overwritten -->',
    '# Project memory (merged index)',
    '',
    'Memory notes are read in place from each harness; nothing is copied.',
    '',
  ]
  for (const source of sources) {
    if (source.entries.length === 0) continue
    lines.push(`## ${source.harness} (\`${display(source.dir, home)}\`)`, '')
    for (const note of source.entries) {
      lines.push(`- \`${note.path}\`${note.description.length > 0 ? ` — ${note.description}` : ''}`)
    }
    lines.push('')
  }
  if (canonicalNotes.length > 0) {
    lines.push(`## shared (${display(project.canonical, home)})`, '')
    for (const note of canonicalNotes) lines.push(`- \`${note.path}\`${note.description.length > 0 ? ` — ${note.description}` : ''}`)
    lines.push('')
  }
  const content = `${lines.join('\n').trimEnd()}\n`
  const indexPath = join(project.canonical, 'MEMORY.md')
  const state = inspectPath(indexPath)
  if (state.kind === 'file') {
    const previous = fileHash(indexPath)
    try {
      if (readFileSync(indexPath, 'utf8') === content) return
    } catch {
      // Rewrite unreadable index.
    }
    actions.push({ mode: 'write', scope: 'project', harness: 'merged', path: indexPath, writePath: indexPath, content, previous, reason: 'refresh the merged memory index' })
  } else if (state.kind === 'missing') {
    actions.push({ mode: 'create', scope: 'project', harness: 'merged', path: indexPath, writePath: indexPath, content, previous: undefined, reason: 'create the merged memory index' })
  } else {
    conflicts.push({ scope: 'project', harness: 'merged', path: indexPath, reason: 'index path exists but is not a regular file; left untouched' })
  }
}

/** Plan agent-level memory (per agent, Codex layout is the reference). */
function planAgentMemory(layout, requested, actions, conflicts, notes) {
  const { canonicalRoot, sources } = layout.agents
  const names = new Set()
  for (const source of sources) {
    let entries
    try {
      entries = readdirSync(source.root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) if (entry.isDirectory()) names.add(entry.name)
  }
  try {
    for (const entry of readdirSync(canonicalRoot, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name)
  } catch {
    // No canonical agent memory yet.
  }
  if (names.size === 0) return
  for (const name of [...names].sort()) {
    const canonical = join(canonicalRoot, name)
    const candidates = sources.map(source => ({
      harness: source.harness,
      path: join(source.root, name),
      parent: source.root,
    }))
    const existing = candidates.filter(candidate => inspectPath(candidate.path).kind !== 'missing')
    if (existing.length === 0 && inspectPath(canonical).kind === 'missing') continue
    planDirectoryFamily({
      canonical,
      sources: candidates,
      scope: `agent:${name}`,
      priority: AGENT_AUTHORITY_ORDER,
      requested,
      home: layout.home,
      actions,
      conflicts,
      notes,
      createCanonical: false,
    })
  }
}

/**
 * Build a memory-sync plan without touching the filesystem.
 * @param {object} layout - Result of {@link resolveMemoryLayout}.
 * @param {object} [options] - `{ mode?: 'authority'|'merge'|'off', authority?: string }`.
 */
export function planMemory(layout, options = {}) {
  const mode = options.mode ?? 'authority'
  const authority = options.authority
  const actions = []
  const conflicts = []
  const notes = []
  if (mode === 'off') {
    notes.push('[memory] disabled (--memory=off)')
    return { mode, authority, actions, conflicts, notes, layout }
  }
  if (mode !== 'authority' && mode !== 'merge') throw new Error(`unknown memory mode "${mode}"`)
  if (layout.project !== undefined) {
    if (mode === 'authority') {
      planDirectoryFamily({
        canonical: layout.project.canonical,
        sources: layout.project.adapters,
        scope: 'project',
        priority: PROJECT_AUTHORITY_ORDER,
        requested: authority,
        home: layout.home,
        actions,
        conflicts,
        notes,
        createCanonical: true,
      })
    } else {
      planMergedIndex(layout.project, layout.home, actions, notes, conflicts)
    }
    planProjectIndex(layout.project, mode, actions, notes)
  } else {
    notes.push('[memory] no project directory; project memory skipped')
  }
  planAgentMemory({ ...layout, actions }, authority, actions, conflicts, notes)
  return { mode, authority, actions, conflicts, notes, layout }
}

/**
 * Apply a memory plan. Symlinks are re-validated before creation; generated
 * files only overwrite the exact content observed during planning.
 */
export function applyMemoryPlan(plan) {
  const applied = []
  const failed = []
  for (const action of plan.actions) {
    try {
      if (action.mode === 'mkdir') {
        mkdirSync(action.path, { recursive: true })
        applied.push(action)
        continue
      }
      if (action.mode === 'write' || action.mode === 'create') {
        const parent = dirname(action.writePath)
        mkdirSync(parent, { recursive: true })
        const current = fileHash(action.writePath)
        if (current !== action.previous) {
          failed.push({ ...action, error: 'content changed after planning; skipped' })
          continue
        }
        const tmp = join(parent, `.dsh-unified-context-${process.pid}.tmp`)
        writeFileSync(tmp, action.content)
        renameSync(tmp, action.writePath)
        applied.push(action)
        continue
      }
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
        if (action.empty === true ? !isEmptyDir(action.path) : !sameContent(action.path, action.target)) {
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

/** Human-readable memory plan lines shared by the CLI and the slash command. */
export function renderMemoryPlan(plan, options = {}) {
  const home = options.home ?? plan.layout.home
  const lines = [`[memory] mode: ${plan.mode}${plan.authority === undefined ? '' : ` (authority: ${plan.authority})`}`]
  const groups = [
    ['project', 'project memory'],
    ...plan.actions.filter(action => action.scope?.startsWith('agent:')).map(action => [action.scope, `agent memory ${action.scope.slice(6)}`]),
  ]
  const seen = new Set()
  for (const [scope, label] of groups) {
    if (seen.has(scope)) continue
    seen.add(scope)
    const groupActions = plan.actions.filter(action => action.scope === scope)
    lines.push(`[${label}] ${groupActions.length === 0 ? 'already shared' : `${groupActions.length} change(s)`}`)
    for (const action of groupActions) {
      const symbol = action.mode === 'adopt' ? '*' : action.mode === 'replace' ? '~' : action.mode === 'write' || action.mode === 'create' ? '=' : action.mode === 'mkdir' ? '+' : '+'
      lines.push(`  ${symbol} ${display(action.path, home)}${action.target === undefined ? '' : ` -> ${display(action.target, home)}`}  (${action.reason})`)
    }
  }
  if (plan.conflicts.length > 0) {
    lines.push(`[memory conflicts] ${plan.conflicts.length} item(s) need a decision:`)
    for (const conflict of plan.conflicts) lines.push(`  ! ${display(conflict.path, home)}: ${conflict.reason}`)
  }
  for (const note of plan.notes) lines.push(note)
  lines.push(`[memory] plan: ${plan.actions.length} change(s), ${plan.conflicts.length} conflict(s)`)
  return lines
}
