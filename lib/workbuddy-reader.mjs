/**
 * WorkBuddy (Tencent, macOS) session reader.
 *
 * WorkBuddy stores one JSONL transcript per conversation:
 *   <workbuddyRoot>/projects/<encoded-cwd>/<session-uuid>.jsonl
 *
 * Record types used by the reader:
 *   message/role=user        content [{type:'input_text', text}]  (user text is
 *                            wrapped in injected <system-reminder> blocks; only
 *                            the <user_query>…</user_query> payload is the
 *                            actual user turn)
 *   message/role=assistant   content [{type:'output_text', text}]
 *   reasoning                rawContent [{type:'reasoning_text', text}]
 *   function_call            name, arguments (JSON string), callId
 *   function_call_result     callId, output {type:'text', text}, status
 *   ai-title                 aiTitle (conversation title)
 *   file-history-snapshot    ignored
 *
 * Unlike pi / codex / claude transcripts, WorkBuddy records real tool results,
 * so the normalized assistant message carries a `results` array that
 * lib/convert.mjs turns into real tool/result events (placeholder only when a
 * call has no recorded result).
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { fileLines } from './lines.mjs'

/** Default WorkBuddy data root (`WORKBUDDY_HOME` overrides, matching the app). */
export function defaultWorkbuddyRoot() {
  return process.env.WORKBUDDY_HOME ?? join(homedir(), '.workbuddy')
}

/**
 * Enumerate WorkBuddy conversations, newest metadata first.
 * Only headers are read (a few lines per file); full transcripts are parsed on
 * demand by {@link parseWorkbuddySession}.
 * @param root - WorkBuddy data root (default {@link defaultWorkbuddyRoot}).
 * @returns [{ file, id, cwd, createdAt }]
 */
export function listWorkbuddySessions(root = defaultWorkbuddyRoot()) {
  const projectsDir = join(root, 'projects')
  let projects
  try {
    projects = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const sessions = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(projectsDir, project.name)
    let files
    try {
      files = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const path = join(projectDir, file.name)
      const header = readWorkbuddyHeader(path)
      sessions.push({
        file: path,
        id: header.id ?? file.name.replace(/\.jsonl$/u, ''),
        cwd: header.cwd,
        createdAt: header.createdAt,
      })
    }
  }
  sessions.sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
  return sessions
}

/** Read the header fields from the first few records of one transcript. */
function readWorkbuddyHeader(file) {
  const header = { id: undefined, cwd: undefined, createdAt: undefined }
  let seen = 0
  try {
    for (const line of fileLines(file)) {
      if (seen >= 4) break
      seen += 1
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (header.id === undefined && typeof record.sessionId === 'string') header.id = record.sessionId
      if (header.cwd === undefined && typeof record.cwd === 'string') header.cwd = record.cwd
      if (header.createdAt === undefined && typeof record.timestamp === 'number') header.createdAt = record.timestamp
      if (header.id !== undefined && header.cwd !== undefined) break
    }
  } catch {
    // Unreadable file: keep the header empty; the caller skips it by id.
  }
  return header
}

/**
 * Parse one WorkBuddy conversation into the shared normalized message stream.
 * @param file - transcript path.
 * @returns {{ header: object, messages: object[] }}
 */
export function parseWorkbuddySession(file) {
  const header = {
    id: undefined,
    cwd: undefined,
    title: undefined,
    createdAt: undefined,
    model: undefined,
  }
  const messages = []
  const callSteps = new Map()
  let step = null
  let stepKey

  const flush = () => {
    if (step !== null && step.blocks.length > 0) messages.push(step)
    step = null
    stepKey = undefined
  }
  const startStep = (record) => {
    step = {
      role: 'assistant',
      time: typeof record.timestamp === 'number' ? record.timestamp : 0,
      provider: 'workbuddy',
      model: record.providerData?.model ?? record.providerData?.requestModelId,
      blocks: [],
      results: [],
    }
    stepKey = record.providerData?.messageId ?? record.id
  }

  for (const line of fileLines(file)) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (header.id === undefined && typeof record.sessionId === 'string') header.id = record.sessionId
    if (header.cwd === undefined && typeof record.cwd === 'string') header.cwd = record.cwd
    if (header.createdAt === undefined && typeof record.timestamp === 'number') header.createdAt = record.timestamp

    const recordKey = record.providerData?.messageId ?? record.id
    switch (record.type) {
      case 'ai-title': {
        if (typeof record.aiTitle === 'string' && record.aiTitle.trim().length > 0) header.title = record.aiTitle.trim()
        break
      }
      case 'message': {
        if (record.role === 'user') {
          flush()
          const text = extractUserText(record.content)
          if (text.length > 0) {
            messages.push({ role: 'user', time: record.timestamp ?? 0, blocks: [{ type: 'text', text }] })
          }
        } else if (record.role === 'assistant') {
          if (step !== null && stepKey !== undefined && recordKey !== undefined && stepKey !== recordKey) flush()
          if (step === null) startStep(record)
          const blocks = contentBlocks(record.content)
          step.blocks.push(...blocks)
        }
        break
      }
      case 'reasoning': {
        if (step !== null && stepKey !== undefined && recordKey !== undefined && stepKey !== recordKey) flush()
        if (step === null) startStep(record)
        const text = reasoningText(record)
        if (text.length > 0) step.blocks.push({ type: 'reasoning', text })
        break
      }
      case 'function_call': {
        if (step !== null && stepKey !== undefined && recordKey !== undefined && stepKey !== recordKey) flush()
        if (step === null) startStep(record)
        const callId = typeof record.callId === 'string' && record.callId.length > 0 ? record.callId : record.id
        if (callId === undefined) break
        step.blocks.push({
          type: 'tool-call',
          id: callId,
          name: typeof record.name === 'string' ? record.name : 'unknown',
          arguments: typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {}),
        })
        callSteps.set(callId, step)
        break
      }
      case 'function_call_result': {
        const callId = record.callId
        const owner = callSteps.get(callId) ?? step
        if (owner === null || owner === undefined) break
        owner.results.push({
          callId,
          text: resultText(record.output),
          isError: record.isError === true || record.status === 'error' || record.status === 'failed',
        })
        break
      }
      default:
        break
    }
  }
  flush()
  return {
    header: {
      id: header.id,
      cwd: header.cwd,
      title: header.title,
      createdAt: header.createdAt,
    },
    messages,
  }
}

/** Normalize user content: prefer the explicit <user_query> payload, otherwise strip injected context. */
export function extractUserText(content) {
  if (!Array.isArray(content)) return ''
  const text = content
    .filter(block => block?.type === 'input_text' || block?.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')
  if (text.trim().length === 0) return ''
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gu)]
    .map(match => match[1].trim())
    .filter(Boolean)
  if (queries.length > 0) return queries.join('\n\n')
  const stripped = text
    .replace(/<system-reminder\b[\s\S]*?<\/system-reminder>/gu, '')
    .replace(/<\/?cb_summary>/gu, '')
    .trim()
  return stripped
}

/** Map assistant content to DSH text blocks. */
function contentBlocks(content) {
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (block?.type === 'output_text' || block?.type === 'text') {
      if (typeof block.text === 'string' && block.text.length > 0) blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks
}

/** Reasoning text from `rawContent[].reasoning_text`. */
function reasoningText(record) {
  if (!Array.isArray(record.rawContent)) return ''
  return record.rawContent
    .filter(block => block?.type === 'reasoning_text')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
}

/** Tool result text from WorkBuddy's `output` envelope. */
function resultText(output) {
  if (typeof output === 'string') return output
  if (output !== null && typeof output === 'object') {
    if (typeof output.text === 'string') return output.text
    if (output.type === 'text' && typeof output.text === 'string') return output.text
    try {
      return JSON.stringify(output)
    } catch {
      return ''
    }
  }
  return ''
}
