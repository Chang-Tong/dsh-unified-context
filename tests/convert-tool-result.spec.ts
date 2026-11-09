/**
 * Converter: recorded tool results (WorkBuddy) vs placeholder results (sources
 * that only kept the call). Keeps format-v4 tool/result messages legal.
 */
import { describe, expect, it } from 'vitest'

import { buildDshEvents, TOOL_RESULT_PLACEHOLDER } from '../lib/convert.mjs'

function messagesWith(results?: Array<{ callId: string, text: string, isError?: boolean }>) {
  return [
    { role: 'user', time: 1, blocks: [{ type: 'text', text: '读文件' }] },
    {
      role: 'assistant',
      time: 2,
      provider: 'workbuddy',
      model: 'hy3',
      blocks: [{ type: 'tool-call', id: 'call-1', name: 'Read', arguments: '{}' }],
      ...(results === undefined ? {} : { results }),
    },
  ]
}

function toolResult(events: any[]) {
  const event = events.find(candidate => candidate.type === 'tool/result')
  expect(event).toBeDefined()
  return event.data.message
}

describe('buildDshEvents tool results', () => {
  it('writes the recorded result text and error flag', () => {
    const events = buildDshEvents(messagesWith([{ callId: 'call-1', text: '文件内容', isError: true }]), { toolEvents: true })
    const message = toolResult(events)
    expect(message.role).toBe('tool')
    expect(message.toolCallId).toBe('call-1')
    expect(message.content).toEqual([{ type: 'text', text: '文件内容' }])
    expect(message.isError).toBe(true)
  })

  it('falls back to the placeholder when the source only recorded the call', () => {
    const events = buildDshEvents(messagesWith(), { toolEvents: true })
    expect(toolResult(events).content).toEqual([{ type: 'text', text: TOOL_RESULT_PLACEHOLDER }])
    expect(toolResult(events).isError).toBe(false)
  })

  it('keeps an empty recorded result legal', () => {
    const events = buildDshEvents(messagesWith([{ callId: 'call-1', text: '' }]), { toolEvents: true })
    expect(toolResult(events).content).toEqual([{ type: 'text', text: ' ' }])
  })
})
