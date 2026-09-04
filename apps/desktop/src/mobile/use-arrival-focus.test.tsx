import { useRef, type ReactElement } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus, type ArrivalFocusOptions } from './use-arrival-focus'

interface ArrivalFocusProbeProps extends Omit<ArrivalFocusOptions, 'target'> {
  inert?: boolean
  baseUiInert?: boolean
  hidden?: boolean
}

function ArrivalFocusProbe({
  inert,
  baseUiInert,
  hidden,
  ...options
}: ArrivalFocusProbeProps): ReactElement {
  const target = useRef<HTMLInputElement>(null)
  useArrivalFocus({ ...options, target })
  return (
    <div inert={inert} data-base-ui-inert={baseUiInert ? '' : undefined} aria-hidden={hidden}>
      <input ref={target} aria-label="Arrival target" defaultValue="Existing query" />
    </div>
  )
}

async function mountFocus(initial: ArrivalFocusProbeProps) {
  const focus = vi.spyOn(HTMLInputElement.prototype, 'focus')
  const view = await render(<ArrivalFocusProbe {...initial} />)
  return { view, focus }
}

afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
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
    await expect.element(page.getByRole('textbox', { name: 'Arrival target' })).toHaveFocus()
  })

  it('focuses on a capture re-arrival (the double-tap while already shown)', async () => {
    const { view, focus } = await mountFocus({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
    })
    await view.rerender(<ArrivalFocusProbe arrivalSeq={2} arrivalFocusEditor />)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('consumes each arrival once — unrelated re-renders do not re-focus', async () => {
    const { view, focus } = await mountFocus({
      arrivalSeq: 2,
      arrivalFocusEditor: true,
    })
    await view.rerender(<ArrivalFocusProbe arrivalSeq={2} arrivalFocusEditor />)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('ignores arrivals without the focus flag', async () => {
    const { view, focus } = await mountFocus({
      arrivalSeq: 1,
      arrivalFocusEditor: false,
    })
    await view.rerender(<ArrivalFocusProbe arrivalSeq={2} arrivalFocusEditor={false} />)
    expect(focus).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'a native inert container', props: { inert: true } },
    { name: 'a Base UI inert container', props: { baseUiInert: true } },
    { name: 'an aria-hidden container', props: { hidden: true } },
  ])('does not focus an arrival behind $name', async ({ props }) => {
    const { focus } = await mountFocus({
      arrivalSeq: 3,
      arrivalFocusEditor: true,
      ...props,
    })
    expect(focus).not.toHaveBeenCalled()
  })
})
