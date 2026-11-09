/**
 * Apply planned automations through the host schedule service.
 *
 * The pure plan lives in lib/automations-plan.mjs (Codex TOML + WorkBuddy
 * SQLite → dsh scheduled tasks). This module owns the only side effects:
 * `ctx.schedule.create` for new tasks and `ctx.schedule.edit` to import them
 * paused by default, so the source automation can be switched off first.
 */

import { planAutomations, renderAutomationPlan } from '../lib/automations-plan.mjs'

export { planAutomations, renderAutomationPlan }

/** Trimmed title used both for matching and display. */
function titleOf(task) {
  return String(task?.title ?? task?.record?.title ?? '').trim()
}

/** Prompt text of an existing task, across service/tool result shapes. */
function promptOf(task) {
  return task?.prompt ?? task?.record?.prompt ?? ''
}

/** Normalize a schedule page (service page or array). */
function pageItems(page) {
  if (Array.isArray(page)) return page
  return Array.isArray(page?.items) ? page.items : []
}

/**
 * Import every planned automation as a dsh scheduled task.
 * @param ctx - Plugin context with `schedule` and `sessionPersistence`.
 * @param options - Automation options (`activate`, `only`, `exclude`, `timeZone`, `dryRun`) plus source paths.
 * @param actorSessionId - Session id recorded as the task creator.
 * @returns {{ lines: string[], created: number, skipped: number, failed: number, plan: object|null }}
 */
export async function importAutomations(ctx, options = {}, actorSessionId = undefined) {
  const lines = []
  const schedule = ctx.get?.('schedule')
  let importedSessions = []
  try {
    const snapshots = await ctx.sessionPersistence.list()
    importedSessions = snapshots.map(snapshot => ({ id: snapshot.header.id, cwd: snapshot.header.cwd }))
  } catch (error) {
    lines.push(`[automations] could not read existing sessions: ${error?.message ?? error}`)
  }

  const plan = planAutomations({ ...options, dryRun: options.dryRun === true }, importedSessions)
  if (schedule === undefined) {
    lines.push('[automations] schedule service is not loaded; nothing was created')
    lines.push(...renderAutomationPlan(plan))
    return { lines, created: 0, skipped: 0, failed: 0, plan }
  }
  if (options.dryRun === true) {
    lines.push(...renderAutomationPlan(plan))
    lines.push('[automations] dry run: nothing was created')
    return { lines, created: 0, skipped: 0, failed: 0, plan }
  }

  const existing = new Map()
  try {
    for (const task of pageItems(await schedule.list({ limit: 500 }))) {
      const title = titleOf(task)
      if (title.length === 0) continue
      if (!existing.has(title)) existing.set(title, [])
      existing.get(title).push(task)
    }
  } catch (error) {
    lines.push(`[automations] could not list existing tasks: ${error?.message ?? error}`)
  }

  let created = 0
  let skipped = 0
  let failed = 0
  for (const item of plan.items) {
    const sameTitle = existing.get(item.title)
    if (sameTitle !== undefined) {
      const identical = sameTitle.some(task => promptOf(task) === item.prompt)
      skipped += 1
      lines.push(
        identical
          ? `  [skipped] ${item.sourceId}: "${item.title}" is already imported`
          : `  [skipped] ${item.sourceId}: a task titled "${item.title}" already exists with a different instruction — edit or delete it first`,
      )
      continue
    }
    try {
      const task = await schedule.create({
        title: item.title,
        prompt: item.prompt,
        timing: item.timing,
        target: item.target,
      }, actorSessionId)
      const id = task?.id ?? task?.record?.id
      if (item.active !== true && id !== undefined) {
        await schedule.edit({ id, action: 'update', patch: { active: false } }, actorSessionId)
      }
      created += 1
      lines.push(`  [created] ${item.sourceId}: "${item.title}" (${item.active ? 'active' : 'paused'})`)
      for (const warning of item.warnings) lines.push(`      ! ${warning}`)
    } catch (error) {
      failed += 1
      lines.push(`  [failed] ${item.sourceId}: ${error?.message ?? error}`)
    }
  }
  for (const skip of plan.skipped) lines.push(`  [skipped] ${skip.sourceId}: ${skip.reason}`)
  lines.push(`[automations] result: created ${created}, skipped ${skipped}, failed ${failed}`)
  return { lines, created, skipped, failed, plan }
}
