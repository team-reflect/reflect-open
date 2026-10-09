import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isApplePlatform } from '@/lib/keybindings.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import { MOD_KEY_REVEAL_DELAY_MS, useModKeyHeld } from './use-mod-key-held.ts'

const MOD_KEY_NAME = isApplePlatform() ? 'Meta' : 'Control'

function keydown(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...options }))
}

function keyup(key: string, options: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key, ...options }))
}

function pressMod(): void {
  keydown(MOD_KEY_NAME, MOD_KEY)
}

function elapse(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useModKeyHeld', () => {
  it('reveals after Mod is held alone past the delay and hides on release', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(pressMod)
    elapse(MOD_KEY_REVEAL_DELAY_MS - 1)
    expect(result.current).toBe(false)

    elapse(1)
    expect(result.current).toBe(true)

    act(() => keyup(MOD_KEY_NAME))
    expect(result.current).toBe(false)
  })

  it('never reveals for a quick chord', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(pressMod)
    act(() => keydown('s', MOD_KEY))
    elapse(MOD_KEY_REVEAL_DELAY_MS * 2)

    expect(result.current).toBe(false)
  })

  it('stays revealed while a number is pressed with Mod still held', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(pressMod)
    elapse(MOD_KEY_REVEAL_DELAY_MS)
    act(() => keydown('6', MOD_KEY))

    expect(result.current).toBe(true)
  })

  it('ignores Mod pressed with another modifier', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(() => keydown(MOD_KEY_NAME, { ...MOD_KEY, shiftKey: true }))
    elapse(MOD_KEY_REVEAL_DELAY_MS)

    expect(result.current).toBe(false)
  })

  it('hides when the window loses focus, which swallows the keyup', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(pressMod)
    elapse(MOD_KEY_REVEAL_DELAY_MS)
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('hides on a later keydown without Mod held (a missed keyup)', async () => {
    const { result } = await renderHook(() => useModKeyHeld())

    act(pressMod)
    elapse(MOD_KEY_REVEAL_DELAY_MS)
    act(() => keydown('a'))

    expect(result.current).toBe(false)
  })
})
