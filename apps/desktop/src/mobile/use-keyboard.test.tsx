import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { getKeyboardHeight, publishKeyboardHeight, useKeyboardVisible } from './use-keyboard'

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

  it('starts closed and reflects the last published height', () => {
    expect(getKeyboardHeight()).toBe(0)
    publishKeyboardHeight(316)
    expect(getKeyboardHeight()).toBe(316)
    publishKeyboardHeight(0)
    expect(getKeyboardHeight()).toBe(0)
  })

  it('exposes visibility as reactive state', () => {
    const view = renderHook(() => useKeyboardVisible())
    expect(view.result.current).toBe(false)

    act(() => publishKeyboardHeight(316))
    expect(view.result.current).toBe(true)

    act(() => publishKeyboardHeight(0))
    expect(view.result.current).toBe(false)
    view.unmount()
  })

  it('keeps notifying after an unrelated subscriber unmounts', () => {
    const first = renderHook(() => useKeyboardVisible())
    const second = renderHook(() => useKeyboardVisible())
    first.unmount()
    act(() => publishKeyboardHeight(280))
    expect(second.result.current).toBe(true)
    second.unmount()
  })
})
