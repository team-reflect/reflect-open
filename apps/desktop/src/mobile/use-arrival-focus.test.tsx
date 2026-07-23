import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus, type ArrivalFocusOptions } from './use-arrival-focus'

function mountFocus(initial: Omit<ArrivalFocusOptions, 'target'>) {
  const focus = vi.fn()
  const target = { current: { focus } as unknown as HTMLElement }
  const hook = renderHook(
    (props: Omit<ArrivalFocusOptions, 'target'>) => useArrivalFocus({ ...props, target }),
    { initialProps: initial },
  )
  return { hook, focus }
}

afterEach(() => {
  cleanup()
})

describe('useArrivalFocus', () => {
  it('a plain mount does not focus', () => {
    const { focus } = mountFocus({ arrivalSeq: 3, arrivalFocusEditor: false })
    expect(focus).not.toHaveBeenCalled()
  })

  it('honors a focus arrival that raced the mount', () => {
    // Both double-tap navigations landed before the remounting screen first
    // committed: the mount already sees the final seq with the focus flag up.
    const { focus } = mountFocus({ arrivalSeq: 3, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('focuses on a capture re-arrival (the double-tap while already shown)', () => {
    const { hook, focus } = mountFocus({ arrivalSeq: 1, arrivalFocusEditor: false })
    hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('consumes each arrival once — unrelated re-renders do not re-focus', () => {
    const { hook, focus } = mountFocus({ arrivalSeq: 2, arrivalFocusEditor: true })
    hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('ignores arrivals without the focus flag', () => {
    const { hook, focus } = mountFocus({ arrivalSeq: 1, arrivalFocusEditor: false })
    hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: false })
    expect(focus).not.toHaveBeenCalled()
  })
})
