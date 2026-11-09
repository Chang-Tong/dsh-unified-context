/**
 * Automation migration: collect Codex + WorkBuddy automations and plan their
 * DSH scheduled-task equivalents (pure, no writes; the plugin applies them
 * through ctx.schedule).
 */

import { homedir } from 'node:os'

import { collectCodexAutomations, planAutomationImport } from './automations.mjs'
import { collectWorkbuddyAutomations, defaultWorkbuddyAutomationsDb } from './workbuddy-automations.mjs'

const WORKBUDDY_SKILLS_WARNING = 'per-automation skill selection is not carried; the scheduled session uses the preset skill catalog'
const WORKBUDDY_PUSH_WARNING = 'WeChat push is not carried; dsh delivers into the target conversation instead'

/**
 * Collect automations from every supported source.
 * @param {object} [options] - `codexHome`, `workbuddyAutomationsDb`.
 * @returns {{ automations: object[], errors: {path: string, message: string}[] }}
 */
export function collectAutomations(options = {}) {
  const codexHome = options.codexHome ?? joinCodexHome()
  const codex = safeCollectCodex(codexHome)
  const workbuddy = collectWorkbuddyAutomations(options.workbuddyAutomationsDb ?? defaultWorkbuddyAutomationsDb())
  const automations = [
    ...codex.automations.map(automation => ({ ...automation, source: 'codex' })),
    ...workbuddy.automations.map(automation => ({ ...automation, id: `wb-${automation.id}`, source: 'workbuddy' })),
  ]
  return {
    automations,
    errors: [...codex.errors, ...workbuddy.errors],
  }
}

/** A broken Codex automation directory must not hide WorkBuddy automations. */
function safeCollectCodex(codexHome) {
  try {
    return collectCodexAutomations(codexHome)
  } catch (error) {
    return { automations: [], errors: [{ path: codexHome, message: error?.message ?? String(error) }] }
  }
}

/** Codex home defaults to ~/.codex (its session root lives under it). */
function joinCodexHome() {
  return `${process.env.HOME ?? homedir()}/.codex`
}

/**
 * Build the scheduled-task plan for both sources.
 * @param {object} options - `importedSessions`, `timeZone`, `now`, `activate`, `only`, `exclude`.
 * @returns {{ items: object[], skipped: object[], errors: object[] }}
 */
export function planAutomations(options = {}, importedSessions = []) {
  const { automations, errors } = collectAutomations(options)
  const byId = new Map(automations.map(automation => [automation.id, automation]))
  const plan = planAutomationImport(automations, {
    importedSessions,
    timeZone: options.timeZone ?? 'Asia/Shanghai',
    now: options.now,
    activate: options.activate === true,
    only: options.only ?? [],
    exclude: options.exclude ?? [],
  })
  for (const item of plan.items) {
    const source = byId.get(item.sourceId)
    if (source?.source === 'workbuddy') {
      if (Array.isArray(source.skills) && source.skills.length > 0) item.warnings.push(WORKBUDDY_SKILLS_WARNING)
      if (source.notificationPolicy === 'push_to_wechat') item.warnings.push(WORKBUDDY_PUSH_WARNING)
    }
  }
  return { ...plan, errors }
}

/** Human-readable plan lines shared by the CLI and the slash command. */
export function renderAutomationPlan(plan, options = {}) {
  const lines = []
  for (const error of plan.errors ?? []) lines.push(`  [unreadable] ${error.path}: ${error.message}`)
  for (const item of plan.items) {
    lines.push(`  ${item.active ? '+' : '~'} ${item.sourceId} -> "${item.title}" (${item.active ? 'active' : 'paused'})`)
    lines.push(`      ${item.timing.rrule.replace(/\n/g, ' | ')}`)
    if (item.target.kind === 'session') lines.push(`      target: existing conversation ${item.target.sessionId}`)
    else lines.push(`      target: ${item.target.kind}${item.target.create?.cwd === undefined ? '' : ` in ${item.target.create.cwd}`}`)
    for (const warning of item.warnings) lines.push(`      ! ${warning}`)
  }
  for (const skip of plan.skipped) lines.push(`  [skipped] ${skip.sourceId}: ${skip.reason}`)
  lines.push(
    `[automations] plan: ${plan.items.length} task(s), ${plan.items.filter(item => item.active).length} active, ${plan.skipped.length} skipped`,
  )
  return lines
}

