/**
 * WorkBuddy reader: conversation JSONL → normalized message stream.
 * Fixtures only (fictional paths/prompts); real WorkBuddy data is never read.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  extractUserText,
  listWorkbuddySessions,
  parseWorkbuddySession,
} from '../lib/workbuddy-reader.mjs'

let roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wb-reader-'))
  roots.push(root)
  return root
}

function writeConversation(root: string, project: string, id: string, records: unknown[]) {
  const dir = join(root, 'projects', project)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  return file
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

describe('extractUserText', () => {
  it('keeps only the <user_query> payload when the turn carries injected context', () => {
    const text = [
      '<system-reminder data-role="user-context">',
      '<user_info>OS: darwin</user_info>',
      '<manually_attached_skills>name: writer</manually_attached_skills>',
      '</system-reminder>',
      '<user_query> 写一篇朱辛庄定价指南 </user_query>',
    ].join('\n')
    expect(extractUserText([{ type: 'input_text', text }])).toBe('写一篇朱辛庄定价指南')
  })

  it('strips injected system reminders and summary wrappers when no user_query exists', () => {
    const text = [
      '<system-reminder data-role="user-context">noise</system-reminder>',
      '<cb_summary>previous work summary</cb_summary>',
    ].join('\n')
    expect(extractUserText([{ type: 'input_text', text }])).toBe('previous work summary')
  })

  it('drops a turn that only contains injected error-recovery context', () => {
    expect(extractUserText([{
      type: 'input_text',
      text: '<system-reminder data-role="error-recovery">Network error occurred, please continue</system-reminder>',
    }])).toBe('')
  })
})

describe('listWorkbuddySessions', () => {
  it('enumerates project transcripts and reads cwd/id from the header records', () => {
    const root = makeRoot()
    writeConversation(root, 'Users-fake-project', 'aaaaaaaa-1111-4222-8333-444444444444', [
      { type: 'message', role: 'user', timestamp: 1000, sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', cwd: '/Users/fake/project', content: [{ type: 'input_text', text: '<user_query>hi</user_query>' }] },
    ])
    writeConversation(root, 'Users-fake-project', 'bbbbbbbb-1111-4222-8333-444444444444', [
      { type: 'file-history-snapshot', timestamp: 2000 },
      { type: 'message', role: 'user', timestamp: 2001, sessionId: 'bbbbbbbb-1111-4222-8333-444444444444', cwd: '/Users/fake/project', content: [{ type: 'input_text', text: 'hello' }] },
    ])
    const sessions = listWorkbuddySessions(root)
    expect(sessions).toHaveLength(2)
    expect(sessions.map(entry => entry.id).sort()).toEqual([
      'aaaaaaaa-1111-4222-8333-444444444444',
      'bbbbbbbb-1111-4222-8333-444444444444',
    ])
    for (const entry of sessions) expect(entry.cwd).toBe('/Users/fake/project')
  })

  it('returns nothing when the projects directory is absent', () => {
    expect(listWorkbuddySessions(join(makeRoot(), 'missing'))).toEqual([])
  })
})

describe('parseWorkbuddySession', () => {
  it('folds reasoning, assistant text, tool calls and real tool results into steps', () => {
    const root = makeRoot()
    const file = writeConversation(root, 'Users-fake-project', 'cccccccc-1111-4222-8333-444444444444', [
      {
        type: 'message',
        role: 'user',
        timestamp: 1000,
        sessionId: 'cccccccc-1111-4222-8333-444444444444',
        cwd: '/Users/fake/project',
        content: [{
          type: 'input_text',
          text: '<system-reminder data-role="user-context">workspace noise</system-reminder><user_query>读取文件并总结</user_query>',
        }],
      },
      {
        type: 'reasoning',
        id: 'reason-1',
        timestamp: 1001,
        providerData: { messageId: 'model-message-1', model: 'hy3' },
        rawContent: [{ type: 'reasoning_text', text: '先读取文件' }],
      },
      {
        type: 'message',
        role: 'assistant',
        timestamp: 1002,
        providerData: { messageId: 'model-message-1', model: 'hy3' },
        content: [{ type: 'output_text', text: '我先读一下。' }],
      },
      {
        type: 'function_call',
        id: 'call-record-1',
        timestamp: 1003,
        callId: 'call-1',
        name: 'Read',
        arguments: '{"path":"/Users/fake/project/a.md"}',
        providerData: { messageId: 'model-message-2' },
      },
      {
        type: 'function_call_result',
        id: 'result-1',
        timestamp: 1004,
        callId: 'call-1',
        status: 'completed',
        output: { type: 'text', text: '文件内容' },
      },
      { type: 'ai-title', timestamp: 1005, aiTitle: '读取文件任务' },
      { type: 'file-history-snapshot', timestamp: 1006, cwd: '/Users/fake/project' },
    ])
    const { header, messages } = parseWorkbuddySession(file)
    expect(header).toMatchObject({
      id: 'cccccccc-1111-4222-8333-444444444444',
      cwd: '/Users/fake/project',
      title: '读取文件任务',
      createdAt: 1000,
    })
    expect(messages).toHaveLength(3)

    expect(messages[0]).toMatchObject({ role: 'user', time: 1000 })
    expect(messages[0].blocks).toEqual([{ type: 'text', text: '读取文件并总结' }])

    expect(messages[1]).toMatchObject({ role: 'assistant', time: 1001, model: 'hy3' })
    expect(messages[1].blocks.map((block: { type: string }) => block.type)).toEqual(['reasoning', 'text'])
    expect(messages[1].results).toEqual([])

    expect(messages[2]).toMatchObject({ role: 'assistant', time: 1003 })
    expect(messages[2].blocks).toContainEqual({
      type: 'tool-call',
      id: 'call-1',
      name: 'Read',
      arguments: '{"path":"/Users/fake/project/a.md"}',
    })
    expect(messages[2].results).toEqual([{ callId: 'call-1', text: '文件内容', isError: false }])
  })

  it('skips empty user turns and tolerates malformed lines', () => {
    const root = makeRoot()
    const dir = join(root, 'projects', 'fake')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'dddddddd-1111-4222-8333-444444444444.jsonl')
    writeFileSync(file, [
      '{not json}',
      JSON.stringify({ type: 'message', role: 'user', timestamp: 10, cwd: '/p', content: [{ type: 'input_text', text: '<system-reminder>x</system-reminder>' }] }),
      JSON.stringify({ type: 'message', role: 'user', timestamp: 11, cwd: '/p', content: [{ type: 'input_text', text: '真实提问' }] }),
      '',
    ].join('\n'))
    const { messages } = parseWorkbuddySession(file)
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([{ type: 'text', text: '真实提问' }])
  })
})
