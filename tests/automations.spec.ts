/**
 * Codex "Automations" → DSH scheduled-task planning.
 *
 * All fixtures are invented and live in a temporary directory (or are plain
 * objects); no real automation prompt is ever read, copied or asserted on.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  collectCodexAutomations,
  nextRruleOccurrence,
  parseToml,
  planAutomationImport,
} from '../lib/automations.mjs'

// 2026-06-15 09:30 Asia/Shanghai — a Monday.
const NOW = new Date('2026-06-15T01:30:00Z')
const ZONE = 'Asia/Shanghai'

const tempDirs: string[] = []

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-automations-'))
  tempDirs.push(dir)
  return dir
}

/** Write `<home>/automations/<id>/automation.toml` and return that directory. */
function writeAutomation(home: string, id: string, content: string): string {
  const dir = join(home, 'automations', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'automation.toml'), content)
  return dir
}

/** Plan input shaped like collectCodexAutomations() output. */
function automation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'morning',
    name: 'Morning fixture check',
    kind: 'cron',
    status: 'ACTIVE',
    prompt: 'Check the fictional fixture and report.',
    rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0',
    cwds: ['/work/fixture'],
    dir: '/home/.codex/automations/morning',
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('parseToml', () => {
  it('parses escapes, integers, booleans and comments', () => {
    const parsed = parseToml([
      '\uFEFF# automation fixture',
      'version = 1',
      'id = "demo"',
      'name = "task \\u4efb\\u52a1"',
      'prompt = "line one\\nline two\\ttab \\"quoted\\" \\\\ end"',
      'enabled = true',
      'offset = -3',
      '',
      '   # indented comment',
    ].join('\n'))
    expect(parsed).toEqual({
      version: 1,
      id: 'demo',
      name: 'task 任务',
      prompt: 'line one\nline two\ttab "quoted" \\ end',
      enabled: true,
      offset: -3,
    })
  })

  it('parses arrays, inline tables and keeps # inside strings', () => {
    const parsed = parseToml([
      'cwds = ["/a", "/b",]',
      'target = { type = "project", project_id = "p-1" }',
      'name = "a # b" # trailing comment',
      'empty = []',
    ].join('\n'))
    expect(parsed.cwds).toEqual(['/a', '/b'])
    expect(parsed.target).toEqual({ type: 'project', project_id: 'p-1' })
    expect(parsed.name).toBe('a # b')
    expect(parsed.empty).toEqual([])
  })

  it('tolerates a BOM, blank lines and CRLF line endings', () => {
    expect(parseToml('\uFEFF\r\n# c\r\nid = "x"\r\n\r\n')).toEqual({ id: 'x' })
  })

  it('throws a line-numbered error on unparsable lines', () => {
    expect(() => parseToml('version = 1\nthis is not toml\n')).toThrow('cannot parse line 2')
    expect(() => parseToml('name = "unterminated\n')).toThrow('unterminated string')
  })
})

describe('collectCodexAutomations', () => {
  it('reads cron and heartbeat automations and ignores root-level files', () => {
    const home = tempHome()
    writeAutomation(home, 'daily', [
      'version = 1',
      'id = "daily"',
      'kind = "cron"',
      'name = "Daily fixture report"',
      'prompt = "Summarize the fixture log."',
      'status = "ACTIVE"',
      'rrule = "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0"',
      'model = "test-model"',
      'reasoning_effort = "high"',
      'target = { type = "project", project_id = "p-1" }',
      'cwds = ["/work/fixture"]',
    ].join('\n'))
    writeAutomation(home, 'thread', [
      'version = 1',
      'id = "thread"',
      'kind = "heartbeat"',
      'name = "Thread fixture"',
      'prompt = "Continue the fixture thread."',
      'status = "PAUSED"',
      'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=4;BYMINUTE=0;BYDAY=MO"',
      'notification_policy = "failed_runs_only"',
      'target_thread_id = "thread-1"',
    ].join('\n'))
    writeFileSync(join(home, 'automations', '.run-jitter-salt'), 'salt')

    const { automations, errors } = collectCodexAutomations(home)
    expect(errors).toEqual([])
    expect(automations.map(entry => entry.id)).toEqual(['daily', 'thread'])
    expect(automations[0]).toMatchObject({
      id: 'daily',
      name: 'Daily fixture report',
      kind: 'cron',
      status: 'ACTIVE',
      prompt: 'Summarize the fixture log.',
      rrule: 'FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0',
      model: 'test-model',
      reasoningEffort: 'high',
      cwds: ['/work/fixture'],
      dir: join(home, 'automations', 'daily'),
    })
    expect(automations[0].targetThreadId).toBeUndefined()
    expect(automations[1]).toMatchObject({
      id: 'thread',
      kind: 'heartbeat',
      status: 'PAUSED',
      targetThreadId: 'thread-1',
      notificationPolicy: 'failed_runs_only',
      cwds: [],
    })
  })

  it('returns an empty result when the automations directory is missing', () => {
    expect(collectCodexAutomations(join(tempHome(), 'missing'))).toEqual({ automations: [], errors: [] })
  })

  it('reports unparsable files without dropping the readable ones', () => {
    const home = tempHome()
    writeAutomation(home, 'ok', 'id = "ok"\nkind = "cron"\nname = "Ok"\nprompt = "Do the fixture."\n')
    writeAutomation(home, 'broken', 'version = 1\nnot a toml line\n')

    const { automations, errors } = collectCodexAutomations(home)
    expect(automations.map(entry => entry.id)).toEqual(['ok'])
    expect(errors).toHaveLength(1)
    expect(errors[0].path).toBe(join(home, 'automations', 'broken', 'automation.toml'))
    expect(errors[0].message).toContain('cannot parse line 2')
  })
})

describe('nextRruleOccurrence', () => {
  it('computes hourly occurrences', () => {
    expect(nextRruleOccurrence('FREQ=HOURLY;INTERVAL=1;BYMINUTE=45', ZONE, NOW).dtstart).toBe('20260615T094500')
    expect(nextRruleOccurrence('FREQ=HOURLY;INTERVAL=1', ZONE, NOW).dtstart).toBe('20260615T100000')
    expect(nextRruleOccurrence('FREQ=HOURLY;BYHOUR=5;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260616T050000')
  })

  it('computes daily occurrences strictly after now', () => {
    expect(nextRruleOccurrence('FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0', ZONE, NOW).dtstart).toBe('20260615T100000')
    expect(nextRruleOccurrence('FREQ=DAILY;BYHOUR=9;BYMINUTE=30;BYSECOND=0', ZONE, NOW).dtstart).toBe('20260616T093000')
    expect(nextRruleOccurrence('FREQ=DAILY;INTERVAL=2;BYHOUR=9;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260617T090000')
  })

  it('computes weekly occurrences', () => {
    expect(nextRruleOccurrence('FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260615T100000')
    expect(nextRruleOccurrence('FREQ=WEEKLY;BYDAY=TU;BYHOUR=0;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260616T000000')
    expect(nextRruleOccurrence('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=30', ZONE, NOW).dtstart).toBe('20260622T093000')
  })

  it('computes monthly and yearly occurrences', () => {
    expect(nextRruleOccurrence('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260701T100000')
    expect(nextRruleOccurrence('FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20270101T000000')
    expect(nextRruleOccurrence('FREQ=YEARLY;BYMONTH=1,4,7,10;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0', ZONE, NOW).dtstart)
      .toBe('20260701T100000')
  })

  it('normalizes the rule and strips an RRULE: prefix', () => {
    const result = nextRruleOccurrence('rrule:freq=daily;byhour=10;byminute=0', ZONE, NOW)
    expect(result.rrule).toBe('FREQ=DAILY;BYHOUR=10;BYMINUTE=0')
    expect(result.dtstart).toBe('20260615T100000')
    expect(result.warnings).toEqual([])
  })

  it('respects the time zone', () => {
    expect(nextRruleOccurrence('FREQ=DAILY;BYHOUR=2;BYMINUTE=0', 'UTC', NOW).dtstart).toBe('20260615T020000')
    expect(nextRruleOccurrence('FREQ=DAILY;BYHOUR=2;BYMINUTE=0', ZONE, NOW).dtstart).toBe('20260616T020000')
  })

  it('falls back with a warning when the rule cannot be computed', () => {
    const unsupported = nextRruleOccurrence('FREQ=SECONDLY;INTERVAL=5', ZONE, NOW)
    expect(unsupported.warnings).toContain('first occurrence is approximate; verify the schedule')
    // now (09:30 local) + 1h
    expect(unsupported.dtstart).toBe('20260615T103000')
    expect(unsupported.rrule).toBe('FREQ=SECONDLY;INTERVAL=5')

    const withHours = nextRruleOccurrence('FREQ=MINUTELY;BYHOUR=10;BYMINUTE=0', ZONE, NOW)
    // next day at the rule's BYHOUR:BYMINUTE
    expect(withHours.dtstart).toBe('20260616T100000')

    const empty = nextRruleOccurrence('', ZONE, NOW)
    expect(empty.rrule).toBe('FREQ=DAILY')
    expect(empty.warnings).toContain('first occurrence is approximate; verify the schedule')

    expect(nextRruleOccurrence('FREQ=DAILY;BYHOUR=25', ZONE, NOW).warnings).toHaveLength(1)
    // Ordinal BYDAY is out of the supported subset.
    expect(nextRruleOccurrence('FREQ=MONTHLY;BYDAY=-1SU;BYHOUR=10;BYMINUTE=0', ZONE, NOW).warnings).toHaveLength(1)
  })
})

describe('planAutomationImport', () => {
  it('maps a cron automation to a new scheduled session in its cwd', () => {
    const { items, skipped } = planAutomationImport([automation()], { now: NOW })
    expect(skipped).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourceId: 'morning',
      title: 'Morning fixture check',
      prompt: 'Check the fictional fixture and report.',
      timing: {
        kind: 'rrule',
        rrule: 'DTSTART;TZID=Asia/Shanghai:20260615T100000\nRRULE:FREQ=DAILY;BYHOUR=10;BYMINUTE=0',
      },
      target: { kind: 'new', create: { cwd: '/work/fixture' } },
      active: false,
    })
    // ACTIVE sources are imported paused by default; the user pauses the
    // Codex automation first and then resumes the dsh task.
    expect(items[0].warnings.join('\n')).toContain('pause it in Codex')
  })

  it('only activates ACTIVE sources when activate is true', () => {
    const plan = planAutomationImport([
      automation(),
      automation({ id: 'paused', status: 'PAUSED' }),
    ], { now: NOW, activate: true })
    expect(plan.items.map(item => [item.sourceId, item.active])).toEqual([
      ['morning', true],
      ['paused', false],
    ])
    expect(plan.items[1].warnings.join('\n')).toContain('paused')
  })

  it('warns that model, reasoning effort and notification policy are not carried', () => {
    const plan = planAutomationImport([
      automation({ model: 'test-model', reasoningEffort: 'high', notificationPolicy: 'failed_runs_only' }),
    ], { now: NOW })
    const warnings = plan.items[0].warnings.join('\n')
    expect(warnings).toContain('model and reasoning effort are not carried')
    expect(warnings).toContain('notification policy is not carried')
  })

  it('targets the imported session for a heartbeat', () => {
    const plan = planAutomationImport([
      automation({ id: 'heartbeat', kind: 'heartbeat', targetThreadId: 'thread-1' }),
    ], { now: NOW, importedSessions: [{ id: 'codex-thread-1', cwd: '/work/thread' }] })
    expect(plan.items[0].target).toEqual({ kind: 'session', sessionId: 'codex-thread-1' })
    expect(plan.items[0].warnings.join('\n')).not.toContain('original conversation was not imported')
  })

  it('falls back to a fresh once-off session when the thread was not imported', () => {
    const plan = planAutomationImport([
      automation({ id: 'heartbeat', kind: 'heartbeat', targetThreadId: 'thread-2' }),
    ], { now: NOW })
    expect(plan.items[0].target).toEqual({ kind: 'new_once', create: { cwd: '/work/fixture' } })
    expect(plan.items[0].warnings.join('\n')).toContain('original conversation was not imported')
  })

  it('omits cwd when the automation records none', () => {
    const plan = planAutomationImport([automation({ cwds: [] })], { now: NOW })
    expect(plan.items[0].target).toEqual({ kind: 'new', create: {} })
    expect(plan.items[0].warnings.join('\n')).toContain('no working directory')
  })

  it('skips unsupported kinds and empty prompts', () => {
    const plan = planAutomationImport([
      automation({ id: 'a', kind: 'manual' }),
      automation({ id: 'b', prompt: '   ' }),
      automation({ id: 'c' }),
    ], { now: NOW })
    expect(plan.items.map(item => item.sourceId)).toEqual(['c'])
    expect(plan.skipped).toEqual([
      { sourceId: 'a', reason: 'unsupported kind "manual"' },
      { sourceId: 'b', reason: 'empty prompt' },
    ])
  })

  it('honors only and exclude id filters', () => {
    const automations = [automation({ id: 'a' }), automation({ id: 'b' }), automation({ id: 'c' })]
    expect(planAutomationImport(automations, { now: NOW, only: ['a', 'c'] }).items.map(item => item.sourceId))
      .toEqual(['a', 'c'])
    expect(planAutomationImport(automations, { now: NOW, exclude: ['b'] }).items.map(item => item.sourceId))
      .toEqual(['a', 'c'])
    expect(planAutomationImport(automations, { now: NOW, only: ['a'], exclude: ['a'] }).items).toEqual([])
  })

  it('sorts items by source id', () => {
    const plan = planAutomationImport([
      automation({ id: 'z' }),
      automation({ id: 'a' }),
      automation({ id: 'm' }),
    ], { now: NOW })
    expect(plan.items.map(item => item.sourceId)).toEqual(['a', 'm', 'z'])
  })

  it('trims and truncates titles to 120 characters', () => {
    const long = planAutomationImport([automation({ name: 'N'.repeat(200) })], { now: NOW })
    expect(long.items[0].title).toHaveLength(120)
    const padded = planAutomationImport([automation({ name: '  Trimmed  ' })], { now: NOW })
    expect(padded.items[0].title).toBe('Trimmed')
  })

  it('normalizes the source rrule in the timing string', () => {
    const plan = planAutomationImport([
      automation({ rrule: 'RRULE:freq=weekly;byday=mo;byhour=10;byminute=0' }),
    ], { now: NOW })
    expect(plan.items[0].timing.rrule).toBe(
      'DTSTART;TZID=Asia/Shanghai:20260615T100000\nRRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0',
    )
  })

  it('uses the configured time zone for DTSTART and TZID', () => {
    const plan = planAutomationImport([
      automation({ rrule: 'FREQ=DAILY;BYHOUR=2;BYMINUTE=0' }),
    ], { now: NOW, timeZone: 'UTC' })
    expect(plan.items[0].timing.rrule).toBe(
      'DTSTART;TZID=UTC:20260615T020000\nRRULE:FREQ=DAILY;BYHOUR=2;BYMINUTE=0',
    )
  })

  it('returns an empty plan for no automations', () => {
    expect(planAutomationImport([], { now: NOW })).toEqual({ items: [], skipped: [] })
    expect(planAutomationImport(undefined, { now: NOW })).toEqual({ items: [], skipped: [] })
  })
})
