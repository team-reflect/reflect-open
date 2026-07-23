import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus, type ArrivalFocusOptions } from './use-arrival-focus'

async function mountFocus(initial: Omit<ArrivalFocusOptions, 'target'>) {
  const focus = vi.fn()
  const target = { current: { focus } as unknown as HTMLElement }
  const hook = await renderHook(
    (props: Omit<ArrivalFocusOptions, 'target'> = initial) =>
      useArrivalFocus({ ...props, target }),
    { initialProps: initial },
  )
  return { hook, focus }
}

afterEach(() => {
  cleanup()
})

describe('useArrivalFocus', () => {
  it('a plain mount does not focus', async () => {
    const { focus } = await mountFocus({ arrivalSeq: 3, arrivalFocusEditor: false })
    expect(focus).not.toHaveBeenCalled()
  })

  it('honors a focus arrival that raced the mount', async () => {
    // Both double-tap navigations landed before the remounting screen first
    // committed: the mount already sees the final seq with the focus flag up.
    const { focus } = await mountFocus({ arrivalSeq: 3, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('focuses on a capture re-arrival (the double-tap while already shown)', async () => {
    const { hook, focus } = await mountFocus({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
    })
    await hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('consumes each arrival once — unrelated re-renders do not re-focus', async () => {
    const { hook, focus } = await mountFocus({
      arrivalSeq: 2,
      arrivalFocusEditor: true,
    })
    await hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: true })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('ignores arrivals without the focus flag', async () => {
    const { hook, focus } = await mountFocus({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
    })
    await hook.rerender({ arrivalSeq: 2, arrivalFocusEditor: false })
    expect(focus).not.toHaveBeenCalled()
  })
})
