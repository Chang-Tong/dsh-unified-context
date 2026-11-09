/**
 * Context parity planner/applier: instructions + skills converge on one shared
 * copy, every harness path becomes a symlink, and a re-run is a no-op.
 * Fixtures only (temp HOME); the real user context is never touched.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  applyContextPlan,
  planContext,
  renderContextPlan,
  resolveContextLayout,
} from '../lib/context.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-context-'))
  roots.push(home)
  for (const dir of ['.dsh', '.codex', '.claude', '.pi/agent', '.config/opencode', '.agents', '.workbuddy', '.agents/skills']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  return home
}

function layoutOf(home: string, projectDir?: string, pushSkills = false) {
  return resolveContextLayout({
    home,
    dshHome: join(home, '.dsh'),
    agentsHome: join(home, '.agents'),
    piAgentRoot: join(home, '.pi', 'agent'),
    opencodeConfig: join(home, '.config', 'opencode'),
    projectDir,
    pushSkills,
  })
}

function writeSkill(root: string, name: string, body: string) {
  write(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n${body}\n`)
}

function isLink(path: string) {
  return lstatSync(path).isSymbolicLink()
}

describe('context instructions', () => {
  it('adopts the richest global instruction file and links every harness to it', () => {
    const home = makeHome()
    write(join(home, '.codex', 'AGENTS.md'), '# shared instructions\n')
    const plan = planContext(layoutOf(home))
    expect(plan.conflicts).toEqual([])

    const adopt = plan.actions.find(action => action.mode === 'adopt')
    expect(adopt.path).toBe(join(home, '.agents', 'AGENTS.md'))
    expect(adopt.target).toBe(join(home, '.codex', 'AGENTS.md'))

    const byPath = new Map(plan.actions.map(action => [action.path, action]))
    for (const adapter of ['.dsh/AGENTS.md', '.claude/CLAUDE.md', '.pi/agent/AGENTS.md', '.config/opencode/AGENTS.md']) {
      expect(byPath.has(join(home, adapter))).toBe(true)
    }

    const result = applyContextPlan(plan)
    expect(result.failed).toEqual([])
    expect(result.applied.length).toBe(plan.actions.length)
    expect(readFileSync(join(home, '.agents', 'AGENTS.md'), 'utf8')).toBe('# shared instructions\n')
    for (const adapter of ['.dsh/AGENTS.md', '.claude/CLAUDE.md', '.pi/agent/AGENTS.md', '.config/opencode/AGENTS.md']) {
      expect(isLink(join(home, adapter))).toBe(true)
      expect(readFileSync(join(home, adapter), 'utf8')).toBe('# shared instructions\n')
    }
    // WorkBuddy has no single global instruction file; nothing is fabricated.
    expect(existsSync(join(home, '.workbuddy', 'AGENTS.md'))).toBe(false)

    const again = planContext(layoutOf(home))
    expect(again.actions).toEqual([])
    expect(renderContextPlan(again).join('\n')).toContain('already shared')
  })

  it('reports divergent instruction files instead of overwriting them', () => {
    const home = makeHome()
    // dsh has adoption priority: its file becomes the hub and the divergent
    // codex file is reported instead of silently overwritten.
    write(join(home, '.codex', 'AGENTS.md'), '# codex\n')
    write(join(home, '.dsh', 'AGENTS.md'), '# dsh instructions\n')
    const plan = planContext(layoutOf(home))
    const conflict = plan.conflicts.find(item => item.path === join(home, '.codex', 'AGENTS.md'))
    expect(conflict).toBeDefined()
    expect(plan.actions.some(action => action.path === join(home, '.codex', 'AGENTS.md'))).toBe(false)
    applyContextPlan(plan)
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toBe('# codex\n')
  })
})

describe('context skills', () => {
  it('converges every harness skill root on one real copy (including WorkBuddy)', () => {
    const home = makeHome()
    const hub = join(home, '.agents', 'skills')
    const codex = join(home, '.codex', 'skills')
    const claude = join(home, '.claude', 'skills')
    const workbuddy = join(home, '.workbuddy', 'skills')
    const opencode = join(home, '.config', 'opencode', 'skills')

    writeSkill(hub, 'hub-skill', 'hub body')
    writeSkill(codex, 'hub-skill', 'hub body')
    writeSkill(codex, 'codex-only', 'codex body')
    writeSkill(claude, 'claude-only', 'claude body')
    writeSkill(workbuddy, 'workbuddy-only', 'wb body')
    writeSkill(opencode, 'opencode-only', 'oc body')

    const plan = planContext(layoutOf(home, undefined, true))
    const result = applyContextPlan(plan)
    expect(result.failed).toEqual([])

    // Harness-only skills are adopted by the hub through links (no copies).
    for (const name of ['codex-only', 'claude-only', 'workbuddy-only', 'opencode-only']) {
      expect(isLink(join(hub, name))).toBe(true)
    }
    expect(realpathSync(join(hub, 'codex-only'))).toBe(realpathSync(join(codex, 'codex-only')))
    expect(realpathSync(join(hub, 'workbuddy-only'))).toBe(realpathSync(join(workbuddy, 'workbuddy-only')))

    // Identical copies become links; the hub entry stays the real directory.
    expect(isLink(join(codex, 'hub-skill'))).toBe(true)
    expect(realpathSync(join(codex, 'hub-skill'))).toBe(realpathSync(join(hub, 'hub-skill')))

    // Hub skills are pushed into WorkBuddy's root (it does not read ~/.agents).
    for (const name of ['hub-skill', 'codex-only', 'claude-only', 'opencode-only']) {
      expect(isLink(join(workbuddy, name))).toBe(true)
    }
    // opencode reads ~/.agents/skills natively: nothing is pushed into its root.
    expect(existsSync(join(opencode, 'hub-skill'))).toBe(false)

    const again = planContext(layoutOf(home, undefined, true))
    expect(again.actions).toEqual([])
  })

  it('is pull-only by default: no links are pushed into other harness roots', () => {
    const home = makeHome()
    writeSkill(join(home, '.agents', 'skills'), 'hub-skill', 'hub body')
    writeSkill(join(home, '.codex', 'skills'), 'codex-only', 'codex body')
    const plan = planContext(layoutOf(home))
    expect(plan.actions.some(action => action.mode === 'adopt' && action.path === join(home, '.agents', 'skills', 'codex-only'))).toBe(true)
    const pushed = plan.actions.filter(action => action.mode === 'link' && action.layer === 'skills')
    expect(pushed).toEqual([])
  })

  it('reports a same-name skill with different content as a conflict', () => {
    const home = makeHome()
    writeSkill(join(home, '.agents', 'skills'), 'shared-name', 'canonical body')
    writeSkill(join(home, '.claude', 'skills'), 'shared-name', 'different body')
    const plan = planContext(layoutOf(home))
    expect(plan.conflicts.some(item => item.path === join(home, '.claude', 'skills', 'shared-name'))).toBe(true)
    applyContextPlan(plan)
    expect(isLink(join(home, '.claude', 'skills', 'shared-name'))).toBe(false)
    expect(readFileSync(join(home, '.claude', 'skills', 'shared-name', 'SKILL.md'), 'utf8')).toContain('different body')
  })
})

describe('project context', () => {
  it('links project instructions and converges the project skill roots', () => {
    const home = makeHome()
    const project = join(home, 'project')
    write(join(project, 'AGENTS.md'), '# project rules\n')
    write(join(project, 'CODEBUDDY.md'), '# project rules\n')
    writeSkill(join(project, '.claude', 'skills'), 'claude-project', 'claude project body')
    writeSkill(join(project, '.workbuddy', 'skills'), 'wb-project', 'wb project body')

    const plan = planContext(layoutOf(home, project))
    expect(plan.actions.some(action => action.path === join(project, 'CLAUDE.md') && action.mode === 'link')).toBe(true)
    expect(plan.actions.some(action => action.path === join(project, 'CODEBUDDY.md') && action.mode === 'replace')).toBe(true)
    expect(plan.actions.some(action => action.mode === 'adopt' && action.path === join(project, '.agents', 'skills', 'claude-project'))).toBe(true)
    expect(plan.actions.some(action => action.mode === 'adopt' && action.path === join(project, '.agents', 'skills', 'wb-project'))).toBe(true)

    const result = applyContextPlan(plan)
    expect(result.failed).toEqual([])
    expect(readFileSync(join(project, 'CLAUDE.md'), 'utf8')).toBe('# project rules\n')
    expect(readFileSync(join(project, 'CODEBUDDY.md'), 'utf8')).toBe('# project rules\n')
    expect(isLink(join(project, 'CODEBUDDY.md'))).toBe(true)
    // No harness roots are fabricated for harnesses not used by this project.
    expect(existsSync(join(project, '.pi'))).toBe(false)
    expect(existsSync(join(project, '.codex'))).toBe(false)

    const again = planContext(layoutOf(home, project))
    expect(again.actions).toEqual([])
  })
})
