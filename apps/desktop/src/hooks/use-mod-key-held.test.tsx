import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detectPlatformFacts } from '@/services/detect-platform.ts'
import { act } from '@/test-utils/act.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import { MOD_KEY_REVEAL_DELAY_MS, useModKeyHeld } from './use-mod-key-held.ts'

const APPLE = detectPlatformFacts(false).isApplePlatform
const MOD_KEY_NAME = APPLE ? 'Meta' : 'Control'

function keydown(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...options }))
}

function keyup(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key, ...options }))
}

function pressMod(): void {
  keydown(MOD_KEY_NAME, MOD_KEY)
}

async function elapse(ms: number): Promise<void> {
  await act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(async () => {
  await cleanup()
  vi.useRealTimers()
})

describe('useModKeyHeld', () => {
  it('reveals after Mod is held alone past the delay and hides on release', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(pressMod)
    await elapse(MOD_KEY_REVEAL_DELAY_MS - 1)
    expect(result.current).toBe(false)

    await elapse(1)
    expect(result.current).toBe(true)

    await act(() => keyup(MOD_KEY_NAME))
    expect(result.current).toBe(false)
  })

  it('never reveals for a quick chord', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(pressMod)
    await act(() => keydown('s', MOD_KEY))
    await elapse(MOD_KEY_REVEAL_DELAY_MS * 2)

    expect(result.current).toBe(false)
  })

  it('stays revealed while a number is pressed with Mod still held', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(pressMod)
    await elapse(MOD_KEY_REVEAL_DELAY_MS)
    await act(() => keydown('6', MOD_KEY))

    expect(result.current).toBe(true)
  })

  it('ignores Mod pressed with another modifier', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(() => keydown(MOD_KEY_NAME, { ...MOD_KEY, shiftKey: true }))
    await elapse(MOD_KEY_REVEAL_DELAY_MS)

    expect(result.current).toBe(false)
  })

  it('hides when the window loses focus, which swallows the keyup', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(pressMod)
    await elapse(MOD_KEY_REVEAL_DELAY_MS)
    expect(result.current).toBe(true)

    await act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('hides on a later keydown without Mod held (a missed keyup)', async () => {
    const { result } = await renderHook(() => useModKeyHeld(APPLE))

    await act(pressMod)
    await elapse(MOD_KEY_REVEAL_DELAY_MS)
    await act(() => keydown('a'))

    expect(result.current).toBe(false)
  })
})
