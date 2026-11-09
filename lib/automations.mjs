/**
 * Codex "Automations" → DSH scheduled-task planning.
 *
 * A Codex automation lives at `<codexHome>/automations/<id>/automation.toml`:
 * a prompt, an RFC 5545 `rrule`, a kind (`cron` | `heartbeat`) and, for
 * heartbeats, the conversation thread it continues. DSH has no automation
 * concept; the closest equivalent is a scheduled task, so this module is the
 * pure planning layer:
 *
 *   parseToml               minimal TOML reader for automation.toml
 *   collectCodexAutomations read every automation directory
 *   nextRruleOccurrence     first local occurrence of an rrule, as DTSTART
 *   planAutomationImport    map automations to dsh schedule items
 *
 * No filesystem writes, no dependencies, no side effects.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const DEFAULT_TIME_ZONE = 'Asia/Shanghai'
const MAX_TITLE_LENGTH = 120
// Yearly rules with INTERVAL>1 need a few years of lookahead; day-level
// scanning keeps this cheap enough for a planner.
const MAX_DAY_OFFSETS = 366 * 5
const MAX_HOUR_STEPS = 24 * 366 * 5

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const FREQUENCIES = new Set(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])

const ACTIVE_PAUSED_WARNING = 'source automation is active; imported paused — pause it in Codex first, then resume here'
const PAUSED_WARNING = 'source automation is paused; imported paused'
const MODEL_WARNING = 'model and reasoning effort are not carried; the dsh preset default is used'
const NOTIFICATION_WARNING = 'notification policy is not carried'
const NO_CWD_WARNING = 'no working directory recorded; the dsh task will use the default working directory'
const FRESH_THREAD_WARNING = 'original conversation was not imported; a fresh conversation is reused'
const APPROXIMATE_WARNING = 'first occurrence is approximate; verify the schedule'

/** Strip one trailing `# comment`, respecting quoted strings. */
function stripComment(line) {
  let inString = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (inString) {
      if (char === '\\') index++
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === '#') {
      return line.slice(0, index)
    }
  }
  return line
}

/** Cursor-based reader for the TOML value subset used by automation.toml. */
class TomlValueParser {
  constructor(text, line) {
    this.text = text
    this.pos = 0
    this.line = line
  }

  fail(message) {
    throw new Error(`cannot parse line ${this.line}: ${message} (value "${this.text.trim()}")`)
  }

  skipSpace() {
    while (this.text[this.pos] !== undefined && /\s/u.test(this.text[this.pos])) this.pos++
  }

  parse() {
    this.skipSpace()
    const char = this.text[this.pos]
    if (char === undefined) this.fail('missing value')
    if (char === '"') return this.parseString()
    if (char === '[') return this.parseArray()
    if (char === '{') return this.parseInlineTable()
    return this.parseScalar()
  }

  parseString() {
    let value = ''
    this.pos++
    for (;;) {
      const char = this.text[this.pos]
      if (char === undefined) this.fail('unterminated string')
      this.pos++
      if (char === '"') return value
      if (char !== '\\') {
        value += char
        continue
      }
      const escape = this.text[this.pos]
      this.pos++
      switch (escape) {
        case 'n': value += '\n'; break
        case 't': value += '\t'; break
        case 'r': value += '\r'; break
        case '"': value += '"'; break
        case '\\': value += '\\'; break
        case 'u': {
          const hex = this.text.slice(this.pos, this.pos + 4)
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) this.fail('invalid \\u escape')
          value += String.fromCharCode(Number.parseInt(hex, 16))
          this.pos += 4
          break
        }
        // Tolerate unknown escapes (prompts are free-form prose).
        default:
          if (escape !== undefined) value += escape
      }
    }
  }

  parseArray() {
    this.pos++
    const values = []
    this.skipSpace()
    if (this.text[this.pos] === ']') {
      this.pos++
      return values
    }
    for (;;) {
      values.push(this.parse())
      this.skipSpace()
      const char = this.text[this.pos]
      if (char === ',') {
        this.pos++
        this.skipSpace()
        if (this.text[this.pos] === ']') {
          this.pos++
          return values
        }
        continue
      }
      if (char === ']') {
        this.pos++
        return values
      }
      this.fail('expected "," or "]" in array')
    }
  }

  parseInlineTable() {
    this.pos++
    const table = {}
    this.skipSpace()
    if (this.text[this.pos] === '}') {
      this.pos++
      return table
    }
    for (;;) {
      this.skipSpace()
      const key = /^[A-Za-z0-9_-]+/u.exec(this.text.slice(this.pos))
      if (key === null) this.fail('expected a key in inline table')
      this.pos += key[0].length
      this.skipSpace()
      if (this.text[this.pos] !== '=') this.fail('expected "=" in inline table')
      this.pos++
      table[key[0]] = this.parse()
      this.skipSpace()
      const char = this.text[this.pos]
      if (char === ',') {
        this.pos++
        continue
      }
      if (char === '}') {
        this.pos++
        return table
      }
      this.fail('expected "," or "}" in inline table')
    }
  }

  parseScalar() {
    const token = /^[^\s,\]}]+/u.exec(this.text.slice(this.pos))
    if (token === null) this.fail('missing value')
    this.pos += token[0].length
    if (token[0] === 'true') return true
    if (token[0] === 'false') return false
    if (/^[+-]?\d+$/u.test(token[0])) return Number(token[0])
    if (/^[+-]?\d*\.\d+$/u.test(token[0])) return Number(token[0])
    this.fail(`unsupported value "${token[0]}"`)
  }

  expectEnd() {
    this.skipSpace()
    if (this.pos < this.text.length) this.fail(`unexpected trailing content "${this.text.slice(this.pos)}"`)
  }
}

/**
 * Minimal TOML parser for Codex automation files: flat `key = value` lines,
 * basic strings with \\n \\t \\r \\" \\\\ and \\uXXXX escapes, integers,
 * floats, booleans, string arrays and inline tables. Line comments start with
 * `#` outside of strings; a UTF-8 BOM and blank lines are tolerated.
 * @param {string} text
 * @returns {Record<string, unknown>} flat table
 * @throws {Error} with the 1-based line number when a line is not a TOML pair
 */
export function parseToml(text) {
  const table = {}
  const lines = String(text).replace(/^\uFEFF/u, '').split(/\r?\n/u)
  for (let index = 0; index < lines.length; index++) {
    const line = stripComment(lines[index]).trim()
    if (line === '') continue
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(\S[\s\S]*)$/u.exec(line)
    if (pair === null) throw new Error(`cannot parse line ${index + 1}: not a "key = value" pair: "${line}"`)
    const parser = new TomlValueParser(pair[2], index + 1)
    table[pair[1]] = parser.parse()
    parser.expectEnd()
  }
  return table
}

/** Normalize one automation.toml table into the collected shape. */
function toAutomation(table, dir) {
  const automation = {
    id: typeof table.id === 'string' && table.id.trim() !== '' ? table.id.trim() : basename(dir),
    name: typeof table.name === 'string' ? table.name : '',
    kind: typeof table.kind === 'string' ? table.kind : '',
    status: typeof table.status === 'string' ? table.status : '',
    prompt: typeof table.prompt === 'string' ? table.prompt : '',
    rrule: typeof table.rrule === 'string' ? table.rrule : '',
    cwds: Array.isArray(table.cwds) ? table.cwds.filter(cwd => typeof cwd === 'string' && cwd !== '') : [],
    dir,
  }
  if (typeof table.model === 'string') automation.model = table.model
  if (typeof table.reasoning_effort === 'string') automation.reasoningEffort = table.reasoning_effort
  if (typeof table.target_thread_id === 'string') automation.targetThreadId = table.target_thread_id
  if (typeof table.notification_policy === 'string') automation.notificationPolicy = table.notification_policy
  return automation
}

/**
 * Collect every `<codexHome>/automations/<dir>/automation.toml`. Files in the
 * automations root (`.run-jitter-salt`) and directories without an
 * automation.toml are ignored; unreadable or unparsable files are reported.
 * @param {string} codexHome
 * @returns {{ automations: object[], errors: { path: string, message: string }[] }}
 */
export function collectCodexAutomations(codexHome) {
  const root = join(String(codexHome), 'automations')
  const automations = []
  const errors = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { automations, errors }
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    const file = join(dir, 'automation.toml')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      // A directory without automation.toml is not an automation.
      if (error?.code !== 'ENOENT') errors.push({ path: file, message: `cannot read automation.toml: ${error.message}` })
      continue
    }
    try {
      automations.push(toAutomation(parseToml(text), dir))
    } catch (error) {
      errors.push({ path: file, message: error.message })
    }
  }
  automations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { automations, errors }
}

/** Parse comma-separated integers: undefined = absent, null = malformed. */
function integerList(parts, key) {
  const raw = parts.get(key)
  if (raw === undefined) return undefined
  const values = []
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim()
    if (!/^[+-]?\d+$/u.test(trimmed)) return null
    values.push(Number(trimmed))
  }
  return values.length === 0 ? null : values
}

/** Parse BYDAY: undefined = absent, null = malformed or ordinal (unsupported). */
function weekdayList(parts) {
  const raw = parts.get('BYDAY')
  if (raw === undefined) return undefined
  const days = []
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim()
    if (!/^(SU|MO|TU|WE|TH|FR|SA)$/u.test(trimmed)) return null
    days.push(WEEKDAYS.indexOf(trimmed))
  }
  return days.length === 0 ? null : days
}

/** Normalize an rrule string (strip `RRULE:`, uppercase parts). */
function parseRrule(rrule) {
  const raw = String(rrule ?? '').trim().replace(/^RRULE:/iu, '').trim()
  const errors = []
  const parts = new Map()
  const normalized = []
  for (const rawPart of raw.split(';')) {
    const part = rawPart.trim()
    if (part === '') continue
    const split = part.indexOf('=')
    if (split <= 0) {
      errors.push(`malformed rrule part "${part}"`)
      normalized.push(part.toUpperCase())
      continue
    }
    const key = part.slice(0, split).trim().toUpperCase()
    const value = part.slice(split + 1).trim().toUpperCase()
    if (value === '') errors.push(`empty rrule value for ${key}`)
    parts.set(key, value)
    normalized.push(`${key}=${value}`)
  }
  if (!parts.has('FREQ')) errors.push('missing FREQ part')
  else if (!FREQUENCIES.has(parts.get('FREQ'))) errors.push(`unsupported FREQ=${parts.get('FREQ')}`)
  return { normalized: normalized.join(';'), parts, errors }
}

const formatterCache = new Map()

/** Intl formatter in the target zone, hourCycle h23 to avoid "24" at midnight. */
function zoneFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/** Wall-clock parts of an instant in `timeZone`. */
function localParts(instant, timeZone) {
  const parts = zoneFormatter(timeZone).formatToParts(instant)
  const fields = {}
  for (const part of parts) {
    if (part.type !== 'literal') fields[part.type] = part.value
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  }
}

/** Offset (ms) of `timeZone` at an instant: local wall time minus UTC. */
function zoneOffset(instant, timeZone) {
  const local = localParts(instant, timeZone)
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - instant
}

/** Convert a wall-clock time in `timeZone` to epoch ms. */
function wallToInstant(wall, timeZone) {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const instant = target - zoneOffset(target, timeZone)
  // Second pass settles DST transitions where the offset changes between the
  // guessed instant and the real one.
  return target - zoneOffset(instant, timeZone)
}

/** Add whole days to a calendar date (timezone independent). */
function addDays(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/** 0 = Sunday … 6 = Saturday. */
function weekdayOf(date) {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/** Number of days in a 1-based month. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** `YYYYMMDDTHHMMSS` in the automation's local time. */
function formatStamp(wall) {
  const pad = (value, width) => String(value).padStart(width, '0')
  return `${pad(wall.year, 4)}${pad(wall.month, 2)}${pad(wall.day, 2)}T${pad(wall.hour, 2)}${pad(wall.minute, 2)}${pad(wall.second, 2)}`
}

/** Interval part: undefined = absent, null = malformed. */
function parseInterval(raw) {
  if (raw === undefined) return 1
  if (!/^\d+$/u.test(raw)) return null
  const interval = Number(raw)
  return interval > 0 ? interval : null
}

/** Earliest occurrence for HOURLY rules, anchored at the current local hour. */
function findHourlyOccurrence(zone, reference, interval, filters) {
  const local = localParts(reference.getTime(), zone)
  const minutes = filters.minutes ?? [0]
  const seconds = filters.seconds ?? [0]
  const byDay = filters.byDay
  const byDaySet = byDay === undefined ? undefined : new Set(byDay)
  for (let step = 0; step <= MAX_HOUR_STEPS; step++) {
    if (step % interval !== 0) continue
    const totalHours = local.hour + step
    const date = addDays(local, Math.floor(totalHours / 24))
    const hour = totalHours % 24
    if (filters.hours !== undefined && !filters.hours.includes(hour)) continue
    if (filters.months !== undefined && !filters.months.includes(date.month)) continue
    if (byDaySet !== undefined && !byDaySet.has(weekdayOf(date))) continue
    if (filters.monthDays !== undefined && !filters.monthDays.some(day => matchesMonthDay(date, day))) continue
    for (const minute of minutes) {
      for (const second of seconds) {
        const wall = { ...date, hour, minute, second }
        if (wallToInstant(wall, zone) > reference.getTime()) return wall
      }
    }
  }
  return undefined
}

/** Does a calendar day satisfy a (possibly negative) BYMONTHDAY entry? */
function matchesMonthDay(date, monthDay) {
  if (monthDay > 0) return date.day === monthDay
  return date.day === daysInMonth(date.year, date.month) + monthDay + 1
}

/** Earliest occurrence for DAILY/WEEKLY/MONTHLY/YEARLY rules, anchored at now. */
function findCalendarOccurrence(parts, zone, reference, interval, filters) {
  const freq = parts.get('FREQ')
  const local = localParts(reference.getTime(), zone)
  const localWeekday = weekdayOf(local)
  const hours = filters.hours ?? [0]
  const minutes = filters.minutes ?? [0]
  const seconds = filters.seconds ?? [0]
  const byDaySet = filters.byDay === undefined ? undefined : new Set(filters.byDay)
  // INTERVAL is counted from the period containing now, because the
  // automation's original DTSTART is not part of automation.toml.
  const daysSinceMonday = (localWeekday + 6) % 7
  const matchesDay = (date, offset) => {
    if (filters.months !== undefined && !filters.months.includes(date.month)) return false
    if (freq === 'YEARLY' && filters.months === undefined && date.month !== local.month) return false
    if (byDaySet !== undefined) {
      if (!byDaySet.has(weekdayOf(date))) return false
    } else {
      if (freq === 'WEEKLY' && weekdayOf(date) !== localWeekday) return false
      if ((freq === 'MONTHLY' || freq === 'YEARLY')
        && filters.monthDays === undefined && date.day !== local.day) return false
    }
    // BYMONTHDAY is an expansion for MONTHLY/YEARLY and a limit otherwise;
    // combined with BYDAY it always narrows the day further.
    if (filters.monthDays !== undefined && !filters.monthDays.some(day => matchesMonthDay(date, day))) return false
    switch (freq) {
      case 'DAILY': return offset % interval === 0
      case 'WEEKLY': return Math.floor((daysSinceMonday + offset) / 7) % interval === 0
      case 'MONTHLY': return ((date.year - local.year) * 12 + (date.month - local.month)) % interval === 0
      case 'YEARLY': return (date.year - local.year) % interval === 0
      default: return false
    }
  }
  for (let offset = 0; offset <= MAX_DAY_OFFSETS; offset++) {
    const date = addDays(local, offset)
    if (!matchesDay(date, offset)) continue
    for (const hour of hours) {
      for (const minute of minutes) {
        for (const second of seconds) {
          const wall = { ...date, hour, minute, second }
          if (wallToInstant(wall, zone) > reference.getTime()) return wall
        }
      }
    }
  }
  return undefined
}

/** Next occurrence of a parsed rrule, or undefined when it cannot be computed. */
function findOccurrence(parts, zone, reference) {
  const interval = parseInterval(parts.get('INTERVAL'))
  if (interval === null) return undefined
  const months = integerList(parts, 'BYMONTH')
  if (months === null || (months !== undefined && !months.every(month => month >= 1 && month <= 12))) return undefined
  const monthDays = integerList(parts, 'BYMONTHDAY')
  if (monthDays === null || (monthDays !== undefined && !monthDays.every(day => day !== 0 && day >= -31 && day <= 31))) return undefined
  const hours = integerList(parts, 'BYHOUR')
  if (hours === null || (hours !== undefined && !hours.every(hour => hour >= 0 && hour <= 23))) return undefined
  const minutes = integerList(parts, 'BYMINUTE')
  if (minutes === null || (minutes !== undefined && !minutes.every(minute => minute >= 0 && minute <= 59))) return undefined
  const seconds = integerList(parts, 'BYSECOND')
  if (seconds === null || (seconds !== undefined && !seconds.every(second => second >= 0 && second <= 59))) return undefined
  const byDay = weekdayList(parts)
  if (byDay === null) return undefined
  const filters = { months, monthDays, hours, minutes, seconds, byDay }
  if (parts.get('FREQ') === 'HOURLY') return findHourlyOccurrence(zone, reference, interval, filters)
  return findCalendarOccurrence(parts, zone, reference, interval, filters)
}

/** Approximate first occurrence used when the rrule cannot be computed. */
function approximateOccurrence(parts, zone, reference) {
  const local = localParts(reference.getTime(), zone)
  const hours = integerList(parts, 'BYHOUR')
  if (hours !== null && hours !== undefined && hours.every(hour => hour >= 0 && hour <= 23)) {
    const minutes = integerList(parts, 'BYMINUTE')
    const minute = minutes !== null && minutes !== undefined && minutes[0] >= 0 && minutes[0] <= 59 ? minutes[0] : 0
    const next = addDays(local, 1)
    return { ...next, hour: hours[0], minute, second: 0 }
  }
  const later = localParts(reference.getTime() + 3_600_000, zone)
  return { ...later, second: 0 }
}

/**
 * First local occurrence of `rrule` strictly after `now`, expressed as the
 * DTSTART stamp a DSH scheduled task needs. The rule is normalized (leading
 * `RRULE:` stripped, part names uppercased, order preserved, unknown parts
 * kept). INTERVAL is counted from the period containing `now`, because the
 * automation's original DTSTART is not stored.
 * @param {string} rrule - e.g. "FREQ=DAILY;BYHOUR=9;BYMINUTE=30;BYSECOND=0"
 * @param {string} [timeZone='Asia/Shanghai']
 * @param {Date} [now=new Date()]
 * @returns {{ dtstart: string, rrule: string, warnings: string[] }} `dtstart`
 *   is `YYYYMMDDTHHMMSS` local wall time; `rrule` has no `RRULE:` prefix.
 */
export function nextRruleOccurrence(rrule, timeZone = DEFAULT_TIME_ZONE, now = new Date()) {
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : DEFAULT_TIME_ZONE
  const reference = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(reference.getTime())) throw new TypeError('nextRruleOccurrence: now must be a valid Date')
  const parsed = parseRrule(rrule)
  const warnings = []
  if (parsed.errors.length === 0) {
    const occurrence = findOccurrence(parsed.parts, zone, reference)
    if (occurrence !== undefined) return { dtstart: formatStamp(occurrence), rrule: parsed.normalized, warnings }
  }
  warnings.push(APPROXIMATE_WARNING)
  return {
    dtstart: formatStamp(approximateOccurrence(parsed.parts, zone, reference)),
    // An empty rule still needs a plausible schedule downstream.
    rrule: parsed.normalized === '' ? 'FREQ=DAILY' : parsed.normalized,
    warnings,
  }
}

/** Trimmed title, capped at 120 characters (falls back to the source id). */
function titleFor(automation) {
  const name = typeof automation.name === 'string' ? automation.name.trim() : ''
  const fallback = typeof automation.id === 'string' && automation.id.trim() !== '' ? automation.id.trim() : 'Codex automation'
  return [...(name === '' ? fallback : name)].slice(0, MAX_TITLE_LENGTH).join('')
}

/** Map one source status plus `activate` to the scheduled task's active flag. */
function resolveActive(status, activate, warnings) {
  const normalized = String(status ?? '').toUpperCase()
  if (normalized === 'PAUSED') {
    warnings.push(PAUSED_WARNING)
    return false
  }
  if (normalized === 'ACTIVE') {
    if (activate === true) return true
    warnings.push(ACTIVE_PAUSED_WARNING)
    return false
  }
  warnings.push(`unknown source status "${normalized === '' ? 'missing' : normalized}"; imported paused`)
  return false
}

/** First meaningful cwd of an automation, or undefined. */
function firstCwd(automation) {
  if (!Array.isArray(automation.cwds)) return undefined
  return automation.cwds.find(cwd => typeof cwd === 'string' && cwd.trim() !== '')
}

/** Map a source automation to a dsh schedule target. */
function mapTarget(automation, kind, sessions, warnings) {
  const cwd = firstCwd(automation)
  if (kind === 'heartbeat') {
    const threadId = typeof automation.targetThreadId === 'string' ? automation.targetThreadId.trim() : ''
    const sessionId = threadId === '' ? undefined : `codex-${threadId}`
    if (sessionId !== undefined && sessions.has(sessionId)) return { kind: 'session', sessionId }
    if (sessionId !== undefined) warnings.push(FRESH_THREAD_WARNING)
    if (cwd === undefined) {
      warnings.push(NO_CWD_WARNING)
      return { kind: 'new_once', create: {} }
    }
    return { kind: 'new_once', create: { cwd } }
  }
  if (cwd === undefined) {
    warnings.push(NO_CWD_WARNING)
    return { kind: 'new', create: {} }
  }
  return { kind: 'new', create: { cwd } }
}

/**
 * Plan how Codex automations become DSH scheduled tasks.
 *
 * Nothing is activated by default: an ACTIVE source still arrives paused with
 * a warning, so the user can pause it in Codex first and then resume the DSH
 * task without two schedulers firing. `activate: true` imports ACTIVE sources
 * active (PAUSED sources stay paused).
 * @param {object[]} automations - collectCodexAutomations().automations
 * @param {object} [options]
 * @param {{ id: string, cwd?: string }[]} [options.importedSessions] - every
 *   imported dsh session; ids of the form `codex-<thread id>` are matched.
 * @param {string} [options.timeZone='Asia/Shanghai']
 * @param {Date} [options.now=new Date()]
 * @param {boolean} [options.activate=false]
 * @param {string[]} [options.only] - import only these source ids
 * @param {string[]} [options.exclude] - drop these source ids
 * @returns {{ items: object[], skipped: { sourceId: string, reason: string }[] }}
 */
export function planAutomationImport(automations, options = {}) {
  const {
    importedSessions = [],
    timeZone = DEFAULT_TIME_ZONE,
    now = new Date(),
    activate = false,
    only = [],
    exclude = [],
  } = options ?? {}
  const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : DEFAULT_TIME_ZONE
  const reference = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(reference.getTime())) throw new TypeError('planAutomationImport: options.now must be a valid Date')
  const sessions = new Map()
  for (const session of importedSessions ?? []) {
    if (typeof session?.id === 'string' && session.id.startsWith('codex-')) sessions.set(session.id, session)
  }
  const onlyIds = new Set(Array.isArray(only) ? only : [])
  const excludeIds = new Set(Array.isArray(exclude) ? exclude : [])
  const items = []
  const skipped = []
  for (const automation of automations ?? []) {
    if (automation === null || typeof automation !== 'object') continue
    const sourceId = typeof automation.id === 'string' ? automation.id.trim() : ''
    if (sourceId === '') continue
    if (onlyIds.size > 0 && !onlyIds.has(sourceId)) continue
    if (excludeIds.has(sourceId)) continue
    const prompt = typeof automation.prompt === 'string' ? automation.prompt : ''
    if (prompt.trim() === '') {
      skipped.push({ sourceId, reason: 'empty prompt' })
      continue
    }
    const kind = typeof automation.kind === 'string' ? automation.kind : ''
    if (kind !== 'cron' && kind !== 'heartbeat') {
      skipped.push({ sourceId, reason: `unsupported kind "${kind}"` })
      continue
    }
    const warnings = []
    const active = resolveActive(automation.status, activate, warnings)
    if (automation.model !== undefined || automation.reasoningEffort !== undefined) warnings.push(MODEL_WARNING)
    if (automation.notificationPolicy !== undefined) warnings.push(NOTIFICATION_WARNING)
    const target = mapTarget(automation, kind, sessions, warnings)
    const occurrence = nextRruleOccurrence(automation.rrule, zone, reference)
    warnings.push(...occurrence.warnings)
    items.push({
      sourceId,
      title: titleFor(automation),
      prompt,
      timing: { kind: 'rrule', rrule: `DTSTART;TZID=${zone}:${occurrence.dtstart}\nRRULE:${occurrence.rrule}` },
      target,
      active,
      warnings,
    })
  }
  items.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
  skipped.sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0))
  return { items, skipped }
}
