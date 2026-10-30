import { useState, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pointer } from '@/test-utils/swipe.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollElement, touch } from '@/test-utils/scroll.ts'
import { SwipeRow } from './swipe-row.tsx'

const ACTION_WIDTH = 136

const onBeginInteraction = vi.fn()
const onAction = vi.fn()

function Harness({ initiallyRevealed = false }: { initiallyRevealed?: boolean }): ReactElement {
  const [revealed, setRevealed] = useState(initiallyRevealed)
  return (
    <div style={{ width: 360 }}>
      <button type="button" onClick={() => setRevealed((value) => !value)}>
        Toggle
      </button>
      <SwipeRow
        actionWidth={ACTION_WIDTH}
        revealed={revealed}
        onReveal={() => setRevealed(true)}
        onClose={() => setRevealed(false)}
        onBeginInteraction={onBeginInteraction}
        className="h-12"
        surfaceClassName="bg-background"
        actions={
          <button type="button" style={{ width: ACTION_WIDTH }} onClick={onAction}>
            Delete
          </button>
        }
      >
        <span>Row</span>
      </SwipeRow>
    </div>
  )
}

function mount(ui: ReactElement): ReturnType<typeof renderInApp> {
  return renderInApp(ui, { platform: { ...MOBILE_PLATFORM, reducedMotion: true }, route: null })
}

function getScroller(element: Element): HTMLElement {
  const scroller = element.closest<HTMLElement>('[data-slot="swipe-row"]')
  if (scroller === null) {
    throw new Error('no swipe row')
  }
  return scroller
}

beforeEach(() => {
  onBeginInteraction.mockClear()
  onAction.mockClear()
})

describe('SwipeRow', () => {
  it('reveals the actions once a finger scroll settles open, and closes once it settles shut', async () => {
    const view = await mount(<Harness />)
    const scroller = getScroller(view.getByText('Row').element())
    expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull()

    await scrollElement({ element: scroller, left: ACTION_WIDTH, touch: true })
    await view.getByRole('button', { name: 'Delete' }).click()
    expect(onAction).toHaveBeenCalledOnce()

    await scrollElement({ element: scroller, left: 0, touch: true })
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull())
  })

  it('scrolls itself when `revealed` changes from outside', async () => {
    const view = await mount(<Harness />)
    const scroller = getScroller(view.getByText('Row').element())
    const toggle = view.getByRole('button', { name: 'Toggle' })

    await toggle.click()
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(ACTION_WIDTH))

    await toggle.click()
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(0))
    expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull()
  })

  it('mounts an open row at its open position', async () => {
    const view = await mount(<Harness initiallyRevealed />)
    const scroller = getScroller(view.getByText('Row').element())

    expect(scroller.scrollLeft).toBe(ACTION_WIDTH)
    await expect.element(view.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('keeps its position while a finger is down', async () => {
    const view = await mount(<Harness initiallyRevealed />)
    const scroller = getScroller(view.getByText('Row').element())

    await touch(scroller, 'start')
    await view.getByRole('button', { name: 'Toggle' }).click()

    expect(scroller.scrollLeft).toBe(ACTION_WIDTH)
  })

  it('reports the start of every interaction, a tap included', async () => {
    const view = await mount(<Harness />)

    await pointer(view.getByText('Row').element(), 'pointerdown', 10, 10)

    expect(onBeginInteraction).toHaveBeenCalledOnce()
  })
})
