import { useState, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestSystemPreferencesService } from '@reflect/app/testing'
import { act } from '@/test-utils/act.ts'
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
  return renderInApp(ui, {
    platform: MOBILE_PLATFORM,
    appServices: { systemPreferences: createTestSystemPreferencesService({ reducedMotion: true }) },
    route: null,
  })
}

function getScroller(element: Element): HTMLElement {
  const scroller = element.closest<HTMLElement>('[data-slot="swipe-row"]')
  if (scroller === null) {
    throw new Error('no swipe row')
  }
  return scroller
}

/**
 * Clicks the harness's Toggle button in place. A locator click moves the
 * mouse and scrolls first, which a row test does not need.
 */
async function toggle(view: Awaited<ReturnType<typeof mount>>): Promise<void> {
  const button = view.getByRole('button', { name: 'Toggle' }).element() as HTMLElement
  await act(() => {
    button.click()
  })
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

  it('keeps the actions hidden until the finger lifts and the scroll settles', async () => {
    const view = await mount(<Harness />)
    const scroller = getScroller(view.getByText('Row').element())

    await touch(scroller, 'start')
    await act(async () => {
      const scrolled = new Promise((resolve) => {
        return scroller.addEventListener('scroll', resolve, { once: true })
      })
      scroller.scrollTo({ left: ACTION_WIDTH, behavior: 'instant' })
      await scrolled
    })
    expect(scroller.scrollLeft).toBe(ACTION_WIDTH)
    expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull()

    await touch(scroller, 'end')
    await act(() => {
      scroller.dispatchEvent(new Event('scrollend'))
    })
    await expect.element(view.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('scrolls itself when `revealed` changes from outside', async () => {
    const view = await mount(<Harness />)
    const scroller = getScroller(view.getByText('Row').element())

    await toggle(view)
    await expect.element(view.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(ACTION_WIDTH))

    await toggle(view)
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull())
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(0))
  })

  it('mounts an open row at its open position', async () => {
    const view = await mount(<Harness initiallyRevealed />)
    const scroller = getScroller(view.getByText('Row').element())

    expect(scroller.scrollLeft).toBe(ACTION_WIDTH)
    await expect.element(view.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('keeps its position while a finger is down, and applies the change once it lifts', async () => {
    const view = await mount(<Harness initiallyRevealed />)
    const scroller = getScroller(view.getByText('Row').element())

    await touch(scroller, 'start')
    await toggle(view)
    await vi.waitFor(() => expect(view.getByRole('button', { name: 'Delete' }).query()).toBeNull())
    expect(scroller.scrollLeft).toBe(ACTION_WIDTH)

    // The finger did not move the row, so no settle report follows.
    await touch(scroller, 'end')
    await vi.waitFor(() => expect(scroller.scrollLeft).toBe(0))
  })

  it('reports the start of every interaction, a tap included', async () => {
    const view = await mount(<Harness />)

    await pointer(view.getByText('Row').element(), 'pointerdown', 10, 10)

    expect(onBeginInteraction).toHaveBeenCalledOnce()
  })
})
