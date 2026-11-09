// @vitest-environment node
/**
 * Long-term memory parity: project memory (Claude project dir + WorkBuddy
 * project dir) and agent memory (Codex layout reference). Fixtures only.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applyMemoryPlan,
  planMemory,
  resolveMemoryLayout,
} from '../lib/memory.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  roots.push(home)
  mkdirSync(join(home, '.agents'), { recursive: true })
  return home
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeNote(dir: string, name: string, title: string, description: string) {
  write(join(dir, `${name}.md`), `---\nname: ${title}\ndescription: ${description}\n---\n\n${description}\n`)
}

/** One fake Claude project directory whose first session records the cwd. */
function writeClaudeProject(home: string, projectDir: string, key: string) {
  const dir = join(home, '.claude', 'projects', key)
  write(join(dir, 'session.jsonl'), `${JSON.stringify({ cwd: projectDir, type: 'user' })}\n`)
  return dir
}

function layoutFor(home: string, projectDir: string) {
  return resolveMemoryLayout({
    home,
    agentsHome: join(home, '.agents'),
    projectDir,
  })
}

describe('project memory (authority)', () => {
  it('adopts the authority memory directory and links the other harness to it', () => {
    const home = makeHome()
    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const claudeDir = writeClaudeProject(home, projectDir, '-fake-project')
    writeNote(join(claudeDir, 'memory'), 'uv-python', 'uv-python', 'User prefers uv over pip')
    write(join(claudeDir, 'memory', 'MEMORY.md'), '- [uv-python](uv-python.md)\n')
    writeNote(join(projectDir, '.workbuddy', 'memory'), 'other', 'other', 'different workbuddy note')

    const plan = planMemory(layoutFor(home, projectDir))
    expect(plan.actions.some(action => action.mode === 'adopt' && action.path === join(projectDir, '.agents', 'memory'))).toBe(true)
    expect(plan.actions.some(action => action.mode === 'create' && action.path === join(projectDir, 'AGENTS.md'))).toBe(true)
    expect(plan.conflicts.some(conflict => conflict.path === join(projectDir, '.workbuddy', 'memory'))).toBe(true)

    const result = applyMemoryPlan(plan)
    expect(result.failed).toEqual([])
    const canonical = join(projectDir, '.agents', 'memory')
    expect(lstatSync(canonical).isSymbolicLink()).toBe(true)
    expect(realpathSync(canonical)).toBe(realpathSync(join(claudeDir, 'memory')))
    const agents = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('dsh-unified-context:memory:begin')
    expect(agents).toContain('.agents/memory/uv-python.md')
    expect(agents).toContain('User prefers uv over pip')

    const again = planMemory(layoutFor(home, projectDir))
    expect(again.actions).toEqual([])
  })

  it('replaces an empty non-authority memory directory with a link', () => {
    const home = makeHome()
    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const claudeDir = writeClaudeProject(home, projectDir, '-fake-project')
    writeNote(join(claudeDir, 'memory'), 'note', 'note', 'claude note')
    mkdirSync(join(projectDir, '.workbuddy', 'memory'), { recursive: true })

    const plan = planMemory(layoutFor(home, projectDir))
    const result = applyMemoryPlan(plan)
    expect(result.failed).toEqual([])
    const workbuddy = join(projectDir, '.workbuddy', 'memory')
    expect(lstatSync(workbuddy).isSymbolicLink()).toBe(true)
    expect(realpathSync(workbuddy)).toBe(realpathSync(join(projectDir, '.agents', 'memory')))
  })

  it('can pick WorkBuddy as the authority', () => {
    const home = makeHome()
    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const claudeDir = writeClaudeProject(home, projectDir, '-fake-project')
    writeNote(join(claudeDir, 'memory'), 'claude-note', 'claude-note', 'claude note')
    writeNote(join(projectDir, '.workbuddy', 'memory'), 'wb-note', 'wb-note', 'wb note')

    const plan = planMemory(layoutFor(home, projectDir), { authority: 'workbuddy' })
    const adopt = plan.actions.find(action => action.mode === 'adopt')
    expect(adopt?.target).toBe(join(projectDir, '.workbuddy', 'memory'))
  })
})

describe('agent memory (per agent, Codex layout)', () => {
  it('adopts the Codex agent directory and links Claude’s agent directory to it', () => {
    const home = makeHome()
    const codexAgent = join(home, '.codex', 'agent-memory', 'reviewer')
    writeNote(codexAgent, 'feedback', 'feedback', 'reviewer feedback')
    write(join(codexAgent, 'MEMORY.md'), '- [feedback](feedback.md)\n')
    const claudeAgent = join(home, '.claude', 'agent-memory', 'reviewer')
    writeNote(claudeAgent, 'claude-feedback', 'claude-feedback', 'claude reviewer feedback')

    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const plan = planMemory(layoutFor(home, projectDir))
    const adopt = plan.actions.find(action => action.mode === 'adopt' && action.scope === 'agent:reviewer')
    expect(adopt?.target).toBe(codexAgent)
    const conflict = plan.conflicts.find(item => item.scope === 'agent:reviewer')
    expect(conflict?.path).toBe(claudeAgent)

    const result = applyMemoryPlan(plan)
    expect(result.failed).toEqual([])
    const canonical = join(home, '.agents', 'agent-memory', 'reviewer')
    expect(lstatSync(canonical).isSymbolicLink()).toBe(true)
    expect(realpathSync(canonical)).toBe(realpathSync(codexAgent))
  })
})

describe('merged index mode', () => {
  it('generates an index that references each harness memory in place, without copies', () => {
    const home = makeHome()
    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const claudeDir = writeClaudeProject(home, projectDir, '-fake-project')
    writeNote(join(claudeDir, 'memory'), 'claude-note', 'claude-note', 'claude note')
    writeNote(join(projectDir, '.workbuddy', 'memory'), 'wb-note', 'wb-note', 'wb note')

    const plan = planMemory(layoutFor(home, projectDir), { mode: 'merge' })
    expect(plan.actions.every(action => action.mode !== 'replace' && action.mode !== 'adopt')).toBe(true)
    const indexAction = plan.actions.find(action => action.path === join(projectDir, '.agents', 'memory', 'MEMORY.md'))
    expect(indexAction).toBeDefined()
    const agentsAction = plan.actions.find(action => action.path === join(projectDir, 'AGENTS.md'))
    expect(agentsAction).toBeDefined()

    const result = applyMemoryPlan(plan)
    expect(result.failed).toEqual([])
    const index = readFileSync(join(projectDir, '.agents', 'memory', 'MEMORY.md'), 'utf8')
    expect(index).toContain('claude note')
    expect(index).toContain('wb note')
    expect(index).toContain(join(claudeDir, 'memory'))
    expect(index).toContain(join(projectDir, '.workbuddy', 'memory'))
    expect(lstatSync(join(projectDir, '.workbuddy', 'memory')).isSymbolicLink()).toBe(false)

    const again = planMemory(layoutFor(home, projectDir), { mode: 'merge' })
    expect(again.actions).toEqual([])
  })
})

describe('off mode', () => {
  it('does nothing', () => {
    const home = makeHome()
    const projectDir = join(home, 'project')
    mkdirSync(projectDir, { recursive: true })
    const claudeDir = writeClaudeProject(home, projectDir, '-fake-project')
    writeNote(join(claudeDir, 'memory'), 'note', 'note', 'note')
    const plan = planMemory(layoutFor(home, projectDir), { mode: 'off' })
    expect(plan.actions).toEqual([])
    expect(existsSync(join(projectDir, '.agents'))).toBe(false)
  })
})
