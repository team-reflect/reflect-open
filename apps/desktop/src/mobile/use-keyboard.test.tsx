import { act } from 'react'
import { renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getKeyboardHeight,
  publishKeyboardHeight,
  useKeyboardHeightVar,
  useKeyboardVisible,
} from './use-keyboard'

/**
 * The keyboard-height store behind `--keyboard-height`: imperative consumers
 * (the day carousel's drag guard fires at drag start, outside React) read the
 * last published overlap through {@link getKeyboardHeight}; reactive ones
 * (the shell hiding the tab bar) subscribe through {@link useKeyboardVisible}.
 */
describe('keyboard height store', () => {
  afterEach(() => {
    publishKeyboardHeight(0)
  })

  it('starts closed and reflects the last published height', async () => {
    expect(getKeyboardHeight()).toBe(0)
    publishKeyboardHeight(316)
    expect(getKeyboardHeight()).toBe(316)
    publishKeyboardHeight(0)
    expect(getKeyboardHeight()).toBe(0)
  })

  it('exposes visibility as reactive state', async () => {
    const view = await renderHook(() => useKeyboardVisible())
    expect(view.result.current).toBe(false)

    act(() => publishKeyboardHeight(316))
    expect(view.result.current).toBe(true)

    act(() => publishKeyboardHeight(0))
    expect(view.result.current).toBe(false)
    await view.unmount()
  })

  it('keeps notifying after an unrelated subscriber unmounts', async () => {
    const first = await renderHook(() => useKeyboardVisible())
    const second = await renderHook(() => useKeyboardVisible())
    await first.unmount()
    act(() => publishKeyboardHeight(280))
    expect(second.result.current).toBe(true)
    await second.unmount()
  })
})

/**
 * The visual-viewport half of the store: with the webview pinned by
 * `KeyboardPlugin.swift`, `window.innerHeight - visualViewport.height` is the
 * keyboard overlap. A fake viewport stands in for the real one, which never
 * shrinks inside the test browser.
 */
describe('useKeyboardHeightVar', () => {
  class FakeVisualViewport extends EventTarget {
    height = 800
    offsetTop = 0
    scale = 1
  }

  function installViewport(): FakeVisualViewport {
    const viewport = new FakeVisualViewport()
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })
    return viewport
  }

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'visualViewport')
    Reflect.deleteProperty(window, 'innerHeight')
    publishKeyboardHeight(0)
  })

  it('mirrors the viewport shortfall into the store and the CSS variable', async () => {
    const viewport = installViewport()
    const view = await renderHook(() => useKeyboardHeightVar())

    viewport.height = 464
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(getKeyboardHeight()).toBe(336)
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('336px')

    viewport.height = 800
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(getKeyboardHeight()).toBe(0)
    await view.unmount()
  })

  it('ignores a shrink at or under the keyboard threshold', async () => {
    const viewport = installViewport()
    const view = await renderHook(() => useKeyboardHeightVar())

    viewport.height = 745
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(getKeyboardHeight()).toBe(0)
    await view.unmount()
  })

  it('clears a stale overlap once focus has left every editable element', async () => {
    const viewport = installViewport()
    const view = await renderHook(() => useKeyboardHeightVar())

    viewport.height = 464
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(getKeyboardHeight()).toBe(336)

    // iOS 26.0: the keyboard closed, but the viewport still reports 464.
    vi.useFakeTimers()
    act(() => {
      document.dispatchEvent(new Event('focusout'))
    })
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(getKeyboardHeight()).toBe(0)
    vi.useRealTimers()
    await view.unmount()
  })
})
