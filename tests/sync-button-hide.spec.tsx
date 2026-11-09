/**
 * 结果自动隐藏测试（独立文件：独立 jsdom 环境，避免跨测试的 React 调度残留）。
 *
 * 用假定时器把「10ms 后自动隐藏」变成确定性的顺序：先断言结果出现（定时器未
 * 推进），再推进 10ms 断言结果被清除。真实定时器 + 固定 sleep 会在整套测试
 * 并发时抢跑（结果已隐藏或尚未渲染），这是之前的偶发失败来源。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncButton } from '../src/client/SyncButton.tsx'

describe('SyncButton auto-clear', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('hides the result after the auto-clear delay', async () => {
    const sync = vi.fn().mockResolvedValue({ ok: true, text: 'done' })
    await act(async () => {
      root.render(<SyncButton sync={sync} resultHideMs={10} />)
    })
    const button = container.querySelector('button')
    if (button === null) throw new Error('button not rendered')
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(container.textContent).toContain('done')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(container.textContent).not.toContain('done')
  })
})
