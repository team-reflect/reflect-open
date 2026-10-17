import { act } from '@/test-utils/act.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestAppServices } from '@reflect/app/testing'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useKeyboardHeightVar, useKeyboardVisible } from './use-keyboard.ts'

/**
 * The `KeyboardService` behind `--keyboard-height`, as the app reads it:
 * imperative consumers (the day carousel's drag guard fires at drag start,
 * outside React) read the last published overlap through
 * `KeyboardService.getHeight`; reactive ones (the shell hiding the tab bar)
 * subscribe through {@link useKeyboardVisible}.
 */
describe('keyboard height', () => {
  it('starts closed and reflects the last published height', async () => {
    const { keyboard } = createTestAppServices()
    expect(keyboard.getHeight()).toBe(0)
    keyboard.publish(316)
    expect(keyboard.getHeight()).toBe(316)
    keyboard.publish(0)
    expect(keyboard.getHeight()).toBe(0)
  })

  it('exposes visibility as reactive state', async () => {
    const view = await renderHookInApp(() => useKeyboardVisible())
    const { keyboard } = view.appServices
    expect(view.result.current).toBe(false)

    await act(() => keyboard.publish(316))
    expect(view.result.current).toBe(true)

    await act(() => keyboard.publish(0))
    expect(view.result.current).toBe(false)
    await view.unmount()
  })

  it('keeps notifying after an unrelated subscriber unmounts', async () => {
    const app = createTestCoreServices()
    const appServices = createTestAppServices(app)
    const { keyboard } = appServices
    const first = await renderHookInApp(() => useKeyboardVisible(), { app, appServices })
    const second = await renderHookInApp(() => useKeyboardVisible(), { app, appServices })
    await first.unmount()
    await act(() => keyboard.publish(280))
    expect(second.result.current).toBe(true)
    await second.unmount()
  })
})

/**
 * The visual-viewport reader that feeds the service: with the webview pinned by
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
    Object.defineProperties(window, {
      visualViewport: { value: viewport, configurable: true },
      innerHeight: { value: 800, configurable: true },
    })
    return viewport
  }

  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(window, 'visualViewport')
    Reflect.deleteProperty(window, 'innerHeight')
  })

  it('mirrors the viewport shortfall into the service and the CSS variable', async () => {
    const viewport = installViewport()
    const view = await renderHookInApp(() => useKeyboardHeightVar())
    const { keyboard } = view.appServices

    viewport.height = 464
    await act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(keyboard.getHeight()).toBe(336)
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('336px')

    viewport.height = 800
    await act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(keyboard.getHeight()).toBe(0)
    await view.unmount()
  })

  it('ignores a shrink at or under the keyboard threshold', async () => {
    const viewport = installViewport()
    const view = await renderHookInApp(() => useKeyboardHeightVar())
    const { keyboard } = view.appServices

    viewport.height = 745
    await act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(keyboard.getHeight()).toBe(0)
    await view.unmount()
  })

  it('clears a stale overlap once focus has left every editable element', async () => {
    const viewport = installViewport()
    const view = await renderHookInApp(() => useKeyboardHeightVar())
    const { keyboard } = view.appServices

    viewport.height = 464
    await act(() => {
      viewport.dispatchEvent(new Event('resize'))
    })
    expect(keyboard.getHeight()).toBe(336)

    // iOS 26.0: the keyboard closed, but the viewport still reports 464.
    vi.useFakeTimers()
    await act(() => {
      document.dispatchEvent(new Event('focusout'))
    })
    await act(() => {
      vi.advanceTimersByTime(1750)
    })
    expect(keyboard.getHeight()).toBe(0)
    vi.useRealTimers()
    await view.unmount()
  })
})
