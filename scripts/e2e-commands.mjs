/**
 * Manual end-to-end check for the new slash commands (not part of vitest):
 * runs the real plugin on a real cordis command runtime with a fake
 * persistence provider, then invokes /link-context exactly like the GUI does.
 *
 *   phase 1: isolated fake HOME — /link-context (apply) + re-run (idempotent)
 *   phase 2: real HOME — /link-context --dry-run + /import-automations --dry-run
 *
 * Run: node e2e-commands.mjs   (read-only against the real HOME; phase 1 writes only under /tmp)
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'

import * as ImportPlugin from '../plugin/index.mjs'

async function makeCtx(persistenceRows, config) {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  ctx.provide('sessionPersistence', { list: async () => persistenceRows, ctx: undefined })
  ctx.provide('userQuestions', { ask: async () => ({ answers: [] }), registerProvider() {} })
  await ctx.plugin(ImportPlugin, { offerOnStart: false, toolTruncate: 1000, ...config })
  return ctx
}

async function runCommand(ctx, name, rawInput, cwd) {
  const agent = { session: { id: 'e2e-session', header: { cwd } } }
  const def = ctx.commands.find(agent, name)
  if (def === undefined) throw new Error(`command /${name} not registered`)
  const result = await def.handler({ commandId: 'e2e', agent, rawInput, signal: new AbortController().signal })
  return result?.text ?? JSON.stringify(result)
}

const roots = []
function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-e2e-home-'))
  roots.push(home)
  for (const dir of ['.dsh', '.codex', '.claude', '.pi/agent', '.config/opencode', '.agents', '.agents/skills', '.workbuddy', '.workbuddy/skills']) {
    mkdirSync(join(home, dir), { recursive: true })
  }
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  write(join(home, '.codex', 'AGENTS.md'), '# global instructions from codex\n')
  write(join(home, '.agents', 'skills', 'hub-skill', 'SKILL.md'), '---\nname: hub-skill\ndescription: fixture\n---\n\nhub body\n')
  write(join(home, '.workbuddy', 'skills', 'wb-only', 'SKILL.md'), '---\nname: wb-only\ndescription: fixture\n---\n\nwb body\n')
  return home
}

const realEnv = { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME }
// Assigning `undefined` to process.env stores the string "undefined"; delete instead.
function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

try {
  // ---------- phase 1: isolated HOME, real command apply path ----------
  const fakeHome = makeFakeHome()
  process.env.HOME = fakeHome
  process.env.DSH_HOME = join(fakeHome, '.dsh')
  process.env.DSH_AGENTS_HOME = join(fakeHome, '.agents')
  const rows = [{ header: { id: 'e2e-session', cwd: undefined } }]
  let ctx = await makeCtx(rows, { skillsRoot: join(fakeHome, '.agents', 'skills') })

  const applied = await runCommand(ctx, 'link-context', '', undefined)
  console.log('=== /link-context (apply, fake HOME) ===')
  console.log(applied.split('\n').filter(line => line.startsWith('[context]')).join('\n'))
  const hub = join(fakeHome, '.agents', 'AGENTS.md')
  const dshLink = join(fakeHome, '.dsh', 'AGENTS.md')
  if (!lstatSync(hub).isSymbolicLink()) throw new Error('hub is not a symlink')
  if (!lstatSync(dshLink).isSymbolicLink()) throw new Error('dsh instruction adapter is not a symlink')
  if (!lstatSync(join(fakeHome, '.agents', 'skills', 'wb-only')).isSymbolicLink()) throw new Error('workbuddy skill was not adopted')
  console.log(`hub -> ${readlinkSync(hub)}`)
  console.log(`~/.dsh/AGENTS.md -> ${readlinkSync(dshLink)}`)
  console.log(`hub reads: ${JSON.stringify(readFileSync(hub, 'utf8'))}`)

  const again = await runCommand(ctx, 'link-context', '--dry-run', undefined)
  const planLine = again.split('\n').find(line => line.startsWith('[context] plan:'))
  console.log(`re-run: ${planLine}`)
  if (!planLine.includes('0 link(s), 0 adopt(s), 0 replace(s)')) throw new Error(`not idempotent: ${planLine}`)
  await ctx.stop?.()

  // ---------- phase 2: real HOME, dry-run only ----------
  restoreEnv('HOME', realEnv.HOME)
  restoreEnv('DSH_HOME', realEnv.DSH_HOME)
  restoreEnv('DSH_AGENTS_HOME', realEnv.DSH_AGENTS_HOME)
  ctx = await makeCtx([], {})

  console.log('\n=== /link-context --dry-run (real HOME) ===')
  const dry = await runCommand(ctx, 'link-context', '--dry-run', '/Volumes/外置大脑/Mac迁移/project/05-pr/dsh/dsh-unified-context')
  const interesting = dry.split('\n').filter(line =>
    line.startsWith('[instructions') || line.startsWith('[skills]') || line.startsWith('[conflicts]')
    || line.startsWith('[context]') || line.startsWith('[memory') || line.startsWith('[agent memory')
    || line.startsWith('[project memory') || line.includes('not a dsh-compatible') || line.includes('flat skill'))
  console.log(interesting.slice(0, 30).join('\n'))
  if (!dry.includes('[context] plan:')) throw new Error('dry run did not produce a plan')

  console.log('\n=== /import-automations --dry-run (real HOME) ===')
  const automations = await runCommand(ctx, 'import-automations', '--dry-run', undefined)
  console.log(automations.split('\n').filter(line =>
    line.startsWith('[automations]') || line.includes('WorkBuddy') || line.includes('wb-ai')).join('\n') || automations.slice(0, 400))
  await ctx.stop?.()

  // ---------- phase 3: automation apply path against an in-memory schedule service ----------
  console.log('\n=== /import-automations (apply, in-memory schedule; real sources read-only) ===')
  const tasks = []
  let seq = 0
  const schedule = {
    async list() {
      return { items: [...tasks], shown: tasks.length, total: tasks.length, limit: 500, offset: 0 }
    },
    async create(request) {
      const task = { id: `fake-${++seq}`, title: request.title, prompt: request.prompt, target: request.target, timing: request.timing, status: 'active' }
      tasks.push(task)
      return task
    },
    async edit(request) {
      const task = tasks.find(candidate => candidate.id === request.id)
      if (task === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.action === 'delete') {
        tasks.splice(tasks.indexOf(task), 1)
        return { id: request.id, deleted: true }
      }
      if (request.patch.active === false) task.status = 'paused'
      if (request.patch.active === true) task.status = 'active'
      return task
    },
  }
  ctx = await makeCtx([], {})
  ctx.provide('schedule', schedule)
  const appliedAutomations = await runCommand(ctx, 'import-automations', '', undefined)
  const createdLine = appliedAutomations.split('\n').find(line => line.startsWith('[automations] result:'))
  console.log(createdLine)
  console.log(`tasks: ${tasks.length}, paused: ${tasks.filter(task => task.status === 'paused').length}`)
  if (!createdLine.includes('created 11')) throw new Error(`unexpected create result: ${createdLine}`)
  if (!tasks.every(task => task.status === 'paused')) throw new Error('not every migrated task was paused')

  const againAutomations = await runCommand(ctx, 'import-automations', '', undefined)
  const rerunLine = againAutomations.split('\n').find(line => line.startsWith('[automations] result:'))
  console.log(`re-run: ${rerunLine}`)
  if (!rerunLine.includes('created 0, skipped 11')) throw new Error(`automation import not idempotent: ${rerunLine}`)
  await ctx.stop?.()

  console.log('\nE2E COMMANDS PASS')
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
}
