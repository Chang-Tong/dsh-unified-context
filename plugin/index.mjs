/**
 * dsh-unified-context
 *
 * 把 pi / opencode 的会话、聊天记录、agent 导入 dsh。
 *
 * 在会话里输入（无前导斜杠，dsh 命令系统自动处理）：
 *   /import-pi [--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]
 *   /import-opencode [同上]
 *   /import-codex [同上]
 *   /import-claude-code [同上]
 *   /import-agents
 *   /import-all [同上]
 *
 * 导入经 ctx.sessionPersistence.create + append 写入，导入的会话立即出现在
 * GUI 会话列表并可继续对话；agent 以 skill 包形式写入 $DSH_AGENTS_HOME/skills。
 * 会话 id 稳定（pi-<uuid> / oc-<opencode-id>），重复导入自动跳过。
 *
 * 无 default export（namespace 插件），避免 Loader 丢弃 inject。
 */

import { importAgents, importSessions } from './import-service.mjs'
import { maybeOfferMigration } from './migrate-on-start.mjs'
import { attachSessionsToWorkspaces, listImportedSessions } from './attach-workspaces.mjs'
import { importAutomations } from './automations-import.mjs'
import { applyContextPlan, planContext, renderContextPlan, resolveContextLayout } from '../lib/context.mjs'
import { applyMemoryPlan, planMemory, renderMemoryPlan, resolveMemoryLayout } from '../lib/memory.mjs'
import { defaultWorkbuddyAutomationsDb } from '../lib/workbuddy-automations.mjs'
import { defaultWorkbuddyRoot } from '../lib/workbuddy-reader.mjs'

export const name = 'dsh-unified-context'

/** 需要 commands（注册命令）、sessionPersistence（写入会话）与 userQuestions（迁移询问）。 */
export const inject = ['commands', 'sessionPersistence', 'userQuestions']

/** 解析 `--key value` / `key=value` 形式的命令输入。 */
function parseInput(rawInput) {
  const options = {}
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const eq = token.indexOf('=')
    if (token.startsWith('--') && eq >= 0) {
      options[token.slice(2, eq)] = token.slice(eq + 1)
    } else if (token.startsWith('--') && i + 1 < tokens.length) {
      options[token.slice(2)] = tokens[++i]
    } else if (eq >= 0) {
      options[token.slice(0, eq)] = token.slice(eq + 1)
    }
  }
  return options
}

/** 把命令输入归一成导入选项。 */
function resolveOptions(input, defaults) {
  const options = { ...defaults }
  if (input['limit'] !== undefined) {
    const limit = Number(input['limit'])
    if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数')
    options.limit = limit
  }
  if (input['project'] !== undefined) options.project = input['project']
  if (input['since'] !== undefined) {
    const ms = Number(input['since'])
    options.since = Number.isFinite(ms) && ms > 1e11 ? ms : Date.parse(input['since'])
    if (Number.isNaN(options.since)) throw new Error('--since 无法解析（用 ISO 日期或毫秒时间戳）')
  }
  if (input['no-tools'] !== undefined) options.noTools = true
  if (input['tools-as-text'] !== undefined) options.toolsAsText = true
  if (input['tool-truncate'] !== undefined) {
    const value = Number(input['tool-truncate'])
    if (!Number.isInteger(value) || value < 0) throw new Error('--tool-truncate 必须是非负整数')
    options.toolTruncate = value
  }
  return options
}

/** 默认源路径（与 CLI 脚本一致）。 */
function defaultOptions() {
  const home = process.env.HOME ?? ''
  return {
    piRoot: `${home}/.pi/agent/sessions`,
    piAgentRoot: `${home}/.pi/agent`,
    opencodeDb: `${home}/.local/share/opencode/opencode.db`,
    opencodeConfig: `${home}/.config/opencode`,
    codexRoot: `${home}/.codex/sessions`,
    codexHome: `${home}/.codex`,
    claudeRoot: `${home}/.claude/projects`,
    workbuddyRoot: defaultWorkbuddyRoot(),
    workbuddyAutomationsDb: defaultWorkbuddyAutomationsDb(),
    skillsRoot: joinAgentsSkills(),
    toolTruncate: 1000,
    timeZone: 'Asia/Shanghai',
    memoryMode: 'authority',
  }
}

/** Parse slash-command flags: `--name value`, `--name=value`, and boolean `--name`. */
function parseFlags(rawInput) {
  const flags = {}
  const booleanFlags = new Set(['dry-run', 'activate', 'json', 'push', 'no-push'])
  const tokens = rawInput.trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq >= 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const name = token.slice(2)
    if (booleanFlags.has(name) || tokens[i + 1] === undefined || tokens[i + 1].startsWith('--')) flags[name] = true
    else flags[name] = tokens[++i]
  }
  return flags
}

/** A flag that may list ids either comma-separated or by repetition. */
function flagList(value) {
  if (value === undefined) return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  return raw.map(item => item.trim()).filter(Boolean)
}

/** Working directory of the invoking conversation (default project for context linking). */
async function sessionCwd(ctx, agent) {
  try {
    const snapshots = await ctx.sessionPersistence.list()
    const match = snapshots.find(snapshot => snapshot.header.id === agent.session.id)
    return match?.header.cwd
  } catch {
    return undefined
  }
}

/** Automation-import options shared by /import-automations and /import-all. */
function automationOptions(defaults, flags) {
  return {
    codexHome: defaults.codexHome,
    workbuddyRoot: defaults.workbuddyRoot,
    workbuddyAutomationsDb: defaults.workbuddyAutomationsDb,
    timeZone: typeof flags.timezone === 'string' ? flags.timezone : defaults.timeZone,
    activate: flags.activate === true,
    only: flagList(flags.only),
    exclude: flagList(flags.exclude),
    dryRun: flags['dry-run'] === true,
  }
}

function joinAgentsSkills() {
  const home = process.env.HOME ?? ''
  return `${process.env.DSH_AGENTS_HOME ?? `${home}/.agents`}/skills`
}

/** 注册四个导入命令，并在每个新会话开始时主动询问是否迁移历史数据。 */
export function apply(ctx, config = {}) {
  const defaults = { ...defaultOptions(), ...(config ?? {}) }

  // 会话开始时主动询问：仅全新顶层会话（startup）、带 cwd、有未导入数据时才问；
  // 用户拒绝或导入完成后该项目不再询问（状态记录在 $DSH_HOME 状态文件）。
  if (defaults.offerOnStart !== false) {
    ctx.effect(function* () {
      ctx.on('agent/session-start', ({ agent, source }) => {
        if (source !== 'startup') return
        void maybeOfferMigration(ctx, agent, defaults)
      })
    }, 'dsh-unified-context session-start migration offer')
  }

  const run = async (source, input) => {
    const options = resolveOptions(input, defaults)
    const lines = await importSessions(ctx.sessionPersistence, source, options)
    return { kind: 'success', text: lines.join('\n') }
  }

  ctx.commands.register({
    name: 'import-pi',
    description: 'Import pi sessions (chat history) into dsh (re-runs skip existing)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]' },
    handler: invocation => run('pi', parseInput(invocation.rawInput)),
  })

  ctx.commands.register({
    name: 'import-opencode',
    description: 'Import opencode sessions (chat history) into dsh (re-runs skip existing)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]' },
    handler: invocation => run('opencode', parseInput(invocation.rawInput)),
  })

  ctx.commands.register({
    name: 'import-codex',
    description: 'Import codex sessions (chat history) into dsh (re-runs skip existing)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]' },
    handler: invocation => run('codex', parseInput(invocation.rawInput)),
  })

  ctx.commands.register({
    name: 'import-claude-code',
    description: 'Import claude-code sessions (chat history) into dsh (re-runs skip existing)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]' },
    handler: invocation => run('claude-code', parseInput(invocation.rawInput)),
  })

  ctx.commands.register({
    name: 'import-workbuddy',
    description: 'Import WorkBuddy (Tencent) sessions (chat history) into dsh (re-runs skip existing)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N]' },
    handler: invocation => run('workbuddy', parseInput(invocation.rawInput)),
  })

  ctx.commands.register({
    name: 'link-context',
    description: 'Share ONE context (AGENTS.md/CODEBUDDY.md, skills) across dsh/codex/claude/pi/opencode/WorkBuddy with symlinks — never copies',
    input: { hint: '[--project DIR] [--dry-run] [--push] [--memory=authority|merge|off] [--authority=<harness>]' },
    handler: async (invocation) => {
      const flags = parseFlags(invocation.rawInput)
      const projectDir = typeof flags.project === 'string' ? flags.project : await sessionCwd(ctx, invocation.agent)
      const plan = planContext(resolveContextLayout({ projectDir, pushSkills: flags.push === true }))
      const memoryPlan = planMemory(resolveMemoryLayout({ projectDir }), {
        mode: typeof flags.memory === 'string' ? flags.memory : defaults.memoryMode,
        authority: typeof flags.authority === 'string' ? flags.authority : undefined,
      })
      const lines = [...renderContextPlan(plan), ...renderMemoryPlan(memoryPlan)]
      if (flags['dry-run'] === true) {
        lines.push('[context] dry run: nothing was written')
        return { kind: 'success', text: lines.join('\n') }
      }
      const result = applyContextPlan(plan)
      lines.push(`[context] applied ${result.applied.length} of ${plan.actions.length} change(s); ${result.failed.length} failed`)
      for (const failure of result.failed) lines.push(`  [failed] ${failure.path}: ${failure.error}`)
      const memoryResult = applyMemoryPlan(memoryPlan)
      lines.push(`[memory] applied ${memoryResult.applied.length} of ${memoryPlan.actions.length} change(s); ${memoryResult.failed.length} failed`)
      for (const failure of memoryResult.failed) lines.push(`  [failed] ${failure.path}: ${failure.error}`)
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'import-automations',
    description: 'Migrate Codex + WorkBuddy automations into dsh scheduled tasks (imported paused by default)',
    input: { hint: '[--only id] [--exclude id] [--activate] [--timezone Asia/Shanghai] [--dry-run]' },
    handler: async (invocation) => {
      const flags = parseFlags(invocation.rawInput)
      const result = await importAutomations(ctx, automationOptions(defaults, flags), invocation.agent.session.id)
      return { kind: 'success', text: result.lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'attach-workspaces',
    description: 'Attach imported sessions to their cwd-matched workspace (absolute path disambiguates same-name projects)',
    handler: async () => {
      const sessions = await listImportedSessions(ctx)
      const lines = await attachSessionsToWorkspaces(ctx, sessions)
      return { kind: 'success', text: lines.length === 0 ? '没有可归位的会话（或 workspace 服务未加载）' : lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'import-agents',
    description: 'Convert pi/opencode agents & mode prompts into dsh skills (~/.agents/skills)',
    handler: () => {
      const lines = importAgents(defaults)
      return { kind: 'success', text: lines.join('\n') }
    },
  })

  ctx.commands.register({
    name: 'import-all',
    description: 'Full migration: sessions from all five harnesses + agents/skills + shared context links + automations (imported paused)',
    input: { hint: '[--limit N] [--project 子串] [--since ISO|ms] [--no-tools] [--tool-truncate N] [--context-project DIR] [--memory=authority|merge|off] [--authority=<harness>] [--activate]' },
    handler: async (invocation) => {
      const input = parseInput(invocation.rawInput)
      const flags = parseFlags(invocation.rawInput)
      const options = resolveOptions(input, defaults)
      const lines = []
      for (const source of ['pi', 'opencode', 'codex', 'claude-code', 'workbuddy']) {
        lines.push(...await importSessions(ctx.sessionPersistence, source, options))
      }
      lines.push(...importAgents(defaults))
      const projectDir = typeof flags['context-project'] === 'string' ? flags['context-project'] : await sessionCwd(ctx, invocation.agent)
      const contextPlan = planContext(resolveContextLayout({ projectDir, pushSkills: flags.push === true }))
      const contextResult = applyContextPlan(contextPlan)
      lines.push(`[context] linked ${contextResult.applied.length} item(s), ${contextPlan.conflicts.length} conflict(s), ${contextResult.failed.length} failed`)
      for (const conflict of contextPlan.conflicts.slice(0, 8)) lines.push(`  [conflict] ${conflict.path}: ${conflict.reason}`)
      const memoryPlan = planMemory(resolveMemoryLayout({ projectDir }), {
        mode: typeof flags.memory === 'string' ? flags.memory : defaults.memoryMode,
        authority: typeof flags.authority === 'string' ? flags.authority : undefined,
      })
      const memoryResult = applyMemoryPlan(memoryPlan)
      lines.push(`[memory] project/agent memory: ${memoryResult.applied.length} item(s), ${memoryPlan.conflicts.length} conflict(s), ${memoryResult.failed.length} failed`)
      for (const conflict of memoryPlan.conflicts.slice(0, 8)) lines.push(`  [memory conflict] ${conflict.path}: ${conflict.reason}`)
      const automations = await importAutomations(ctx, automationOptions(defaults, flags), invocation.agent.session.id)
      lines.push(...automations.lines)
      return { kind: 'success', text: lines.join('\n') }
    },
  })
}
