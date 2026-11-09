/**
 * WorkBuddy (Tencent, macOS) automations reader.
 *
 * WorkBuddy keeps scheduled tasks in a small SQLite database:
 *   ~/Library/Application Support/WorkBuddy/automations/automations.db
 * with one `automations` row per task (name, prompt, status, rrule, cwds,
 * model, notification policy). The rows are normalized to the same shape the
 * Codex automation collector produces, so lib/automations.mjs can plan both
 * sources identically.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Default WorkBuddy automations database. */
export function defaultWorkbuddyAutomationsDb() {
  const home = process.env.HOME ?? homedir()
  return (
    process.env.WORKBUDDY_AUTOMATIONS_DB ??
    join(home, 'Library', 'Application Support', 'WorkBuddy', 'automations', 'automations.db')
  )
}

/**
 * Read WorkBuddy automations without writing anything.
 * @param dbPath - SQLite file (default {@link defaultWorkbuddyAutomationsDb}).
 * @returns {{ automations: object[], errors: {path: string, message: string}[] }}
 */
export function collectWorkbuddyAutomations(dbPath = defaultWorkbuddyAutomationsDb()) {
  if (!existsSync(dbPath)) return { automations: [], errors: [] }
  let database
  try {
    // Lazy require support: node:sqlite exists on Node >= 22.5; importing at
    // module load would break environments without it (CLI on older Node).
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    database = new DatabaseSync(dbPath, { readOnly: true })
    database.exec('PRAGMA busy_timeout = 2000')
    const rows = database.prepare(
      'SELECT id, name, prompt, status, schedule_type, rrule, cwds, model_id, model_is_thinking, push_to_wechat, skills_json FROM automations ORDER BY created_at',
    ).all()
    const automations = []
    for (const row of rows) {
      let cwds = []
      try {
        const parsed = JSON.parse(row.cwds ?? '[]')
        if (Array.isArray(parsed)) cwds = parsed.filter(value => typeof value === 'string' && value.length > 0)
      } catch {
        // Malformed cwds: keep the automation but run it with the host default.
      }
      let skills = []
      try {
        const parsed = JSON.parse(row.skills_json ?? '[]')
        if (Array.isArray(parsed)) skills = parsed
      } catch {
        // Ignore malformed skill lists.
      }
      const model = typeof row.model_id === 'string' && row.model_id.length > 0 && row.model_id !== 'auto' ? row.model_id : undefined
      automations.push({
        id: String(row.id),
        name: String(row.name ?? row.id),
        kind: row.schedule_type === 'recurring' && typeof row.rrule === 'string' && row.rrule.length > 0 ? 'cron' : 'unsupported',
        status: row.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE',
        prompt: String(row.prompt ?? ''),
        rrule: typeof row.rrule === 'string' ? row.rrule : '',
        cwds,
        model,
        reasoningEffort: row.model_is_thinking === 1 ? 'thinking' : undefined,
        notificationPolicy: row.push_to_wechat === 1 ? 'push_to_wechat' : undefined,
        skills,
        dir: dbPath,
      })
    }
    return { automations, errors: [] }
  } catch (error) {
    return { automations: [], errors: [{ path: dbPath, message: error?.message ?? String(error) }] }
  } finally {
    try {
      database?.close()
    } catch {
      // Closing a read-only handle is best effort.
    }
  }
}
