import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActiveHeading } from './use-active-heading'

// The reference line is the scroll parent's top (0 in jsdom, no scroll parent)
// plus this offset — kept in sync with ACTIVE_LINE_OFFSET in the hook.
const LINE = 12

let rafCallbacks: FrameRequestCallback[] = []

function flushRaf(): void {
  const callbacks = rafCallbacks
  rafCallbacks = []
  callbacks.forEach((callback) => {
    callback(0)
  })
}

function setTop(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + 20, height: 20, width: 0, left: 0, right: 0, x: 0, y: top }) as DOMRect
}

/** Mount a pane + editor root with `tops.length` headings at the given tops. */
function mountPane(path: string, tops: number[]): HTMLElement {
  const pane = window.document.createElement('div')
  pane.setAttribute('aria-label', `Editing ${path}`)
  const root = window.document.createElement('div')
  root.className = 'reflect-editor'
  tops.forEach((top, index) => {
    const heading = window.document.createElement(`h${(index % 6) + 1}`)
    setTop(heading, top)
    root.appendChild(heading)
  })
  pane.appendChild(root)
  window.document.body.appendChild(pane)
  return root
}

function scroll(): void {
  window.document.dispatchEvent(new Event('scroll'))
}

beforeEach(() => {
  rafCallbacks = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    rafCallbacks.push(callback)
    return rafCallbacks.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  window.document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('useActiveHeading', () => {
  it('activates the last heading whose top has passed the reference line', () => {
    mountPane('notes/a.md', [-100, LINE - 5, 400])
    const { result } = renderHook(() => useActiveHeading('notes/a.md', 3))
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(1)

    // scroll further: the third heading crosses the line too.
    const headings = window.document.querySelectorAll<HTMLElement>('.reflect-editor h1, .reflect-editor h2, .reflect-editor h3')
    setTop(headings[2]!, LINE - 2)
    act(() => {
      scroll()
      flushRaf()
    })
    expect(result.current).toBe(2)

    // scroll back to the very top: nothing has passed the line except the first.
    setTop(headings[0]!, LINE - 1)
    setTop(headings[1]!, 300)
    setTop(headings[2]!, 700)
    act(() => {
      scroll()
      flushRaf()
    })
    expect(result.current).toBe(0)
  })

  it('activates the final heading even with no content below it', () => {
    // All four headings have scrolled above the line — the last one wins.
    mountPane('notes/a.md', [-400, -300, -200, LINE - 3])
    const { result } = renderHook(() => useActiveHeading('notes/a.md', 4))
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(3)
  })

  it('clamps the active index to the heading count', () => {
    // Four DOM headings but the store only knows about two.
    mountPane('notes/a.md', [-100, -90, -80, -70])
    const { result } = renderHook(() => useActiveHeading('notes/a.md', 2))
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(1)
  })

  it('returns 0 and schedules nothing when there are no headings', () => {
    const { result } = renderHook(() => useActiveHeading('notes/a.md', 0))
    expect(result.current).toBe(0)
    expect(rafCallbacks).toHaveLength(0)
  })

  it('resets the active index when the path changes', () => {
    mountPane('notes/a.md', [-100, -50, LINE - 1])
    const { result, rerender } = renderHook(
      ({ path, headingCount }: { path: string; headingCount: number }) =>
        useActiveHeading(path, headingCount),
      { initialProps: { path: 'notes/a.md', headingCount: 3 } },
    )
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(2)

    mountPane('notes/b.md', [5, 400])
    rerender({ path: 'notes/b.md', headingCount: 2 })
    expect(result.current).toBe(0)
  })

  it('keeps the active index when only the heading count changes (same note)', () => {
    // Editing a heading elsewhere in the same note changes headingCount but
    // must not reset the reader's current position.
    const root = mountPane('notes/a.md', [-100, -50, LINE - 1])
    const { result, rerender } = renderHook(
      ({ path, headingCount }: { path: string; headingCount: number }) =>
        useActiveHeading(path, headingCount),
      { initialProps: { path: 'notes/a.md', headingCount: 3 } },
    )
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(2)

    // A fourth heading appears further down; the reader hasn't scrolled, so the
    // active index stays put rather than snapping back to 0.
    const fourth = window.document.createElement('h4')
    setTop(fourth, 800)
    root.appendChild(fourth)
    rerender({ path: 'notes/a.md', headingCount: 4 })
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(2)
  })

  it('recovers when heading DOM is painted after the effect runs (no open-time race)', async () => {
    // Editor root exists but its headings have not been painted yet.
    const pane = window.document.createElement('div')
    pane.setAttribute('aria-label', 'Editing notes/a.md')
    const root = window.document.createElement('div')
    root.className = 'reflect-editor'
    pane.appendChild(root)
    window.document.body.appendChild(pane)

    const { result } = renderHook(() => useActiveHeading('notes/a.md', 2))
    act(() => {
      flushRaf()
    })
    expect(result.current).toBe(0)

    // Headings appear later; the MutationObserver must re-compute.
    await act(async () => {
      const first = window.document.createElement('h1')
      setTop(first, -100)
      const second = window.document.createElement('h2')
      setTop(second, LINE - 4)
      root.append(first, second)
      await Promise.resolve()
      flushRaf()
    })
    expect(result.current).toBe(1)
  })
})
