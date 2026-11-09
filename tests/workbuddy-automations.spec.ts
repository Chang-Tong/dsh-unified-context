/**
 * WorkBuddy automations: SQLite rows → the shared automation shape, and the
 * shared planner maps them to dsh scheduled tasks.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { collectWorkbuddyAutomations } from '../lib/workbuddy-automations.mjs'
import { planAutomationImport } from '../lib/automations.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wb-automations-'))
  roots.push(dir)
  const path = join(dir, 'automations.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    schedule_type TEXT NOT NULL DEFAULT 'recurring',
    next_run_at INTEGER,
    last_run_at INTEGER,
    cwds TEXT NOT NULL DEFAULT '[]',
    rrule TEXT NOT NULL DEFAULT '',
    scheduled_at TEXT,
    valid_from TEXT,
    valid_until TEXT,
    model_id TEXT,
    model_is_thinking INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    push_to_wechat INTEGER NOT NULL DEFAULT 0,
    skills_json TEXT NOT NULL DEFAULT '[]'
  )`)
  return { path, db }
}

describe('collectWorkbuddyAutomations', () => {
  it('normalizes recurring rows into the shared automation shape', () => {
    const { path, db } = makeDb()
    db.prepare(`INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, rrule, model_id, model_is_thinking, push_to_wechat, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'ai-news',
      'Daily AI news',
      'Summarize today in AI.',
      'ACTIVE',
      'recurring',
      '["/Users/fake/wb-project"]',
      'FREQ=DAILY;BYHOUR=17;BYMINUTE=0',
      'auto',
      0,
      1,
      1000,
      1000,
    )
    db.prepare(`INSERT INTO automations (id, name, prompt, status, schedule_type, rrule, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('once-off', 'One-off', 'Run once.', 'PAUSED', 'once', '', 2000, 2000)
    db.close()

    const { automations, errors } = collectWorkbuddyAutomations(path)
    expect(errors).toEqual([])
    expect(automations).toHaveLength(2)
    expect(automations[0]).toMatchObject({
      id: 'ai-news',
      name: 'Daily AI news',
      kind: 'cron',
      status: 'ACTIVE',
      cwds: ['/Users/fake/wb-project'],
      rrule: 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0',
      notificationPolicy: 'push_to_wechat',
    })
    expect(automations[0].model).toBeUndefined()
    expect(automations[1].kind).toBe('unsupported')
  })

  it('plans recurring WorkBuddy automations as paused fresh-conversation tasks', () => {
    const { path, db } = makeDb()
    db.prepare(`INSERT INTO automations (id, name, prompt, status, schedule_type, cwds, rrule, model_id, push_to_wechat, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'ai-news', 'Daily AI news', 'Summarize today in AI.', 'ACTIVE', 'recurring',
      '["/Users/fake/wb-project"]', 'FREQ=DAILY;BYHOUR=17;BYMINUTE=0', 'auto', 1, 1000, 1000,
    )
    db.close()

    const { automations } = collectWorkbuddyAutomations(path)
    const { items, skipped } = planAutomationImport(automations, {
      now: new Date('2026-11-09T01:00:00.000Z'),
    })
    expect(skipped).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourceId: 'ai-news',
      title: 'Daily AI news',
      prompt: 'Summarize today in AI.',
      active: false,
      target: { kind: 'new', create: { cwd: '/Users/fake/wb-project' } },
    })
    expect(items[0].timing.kind).toBe('rrule')
    expect(items[0].timing.rrule).toContain('DTSTART;TZID=Asia/Shanghai:20261109T170000')
    expect(items[0].timing.rrule).toContain('RRULE:FREQ=DAILY;BYHOUR=17;BYMINUTE=0')
    expect(items[0].warnings.join('\n')).toContain('notification policy is not carried')
  })

  it('returns empty results when the database is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-automations-missing-'))
    roots.push(dir)
    expect(collectWorkbuddyAutomations(join(dir, 'absent.db'))).toEqual({ automations: [], errors: [] })
  })
})
