import { useEffect, useState } from 'react'

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'
// How far below the scroll container's top edge a heading must sit before the
// section above it stops being "current". A small offset means a heading
// becomes active as soon as its top scrolls up to the reading area's top.
const ACTIVE_LINE_OFFSET = 12

/** The nearest scrollable ancestor of `element`, or null for the viewport. */
function findScrollParent(element: Element): HTMLElement | null {
  let node = element.parentElement
  while (node !== null) {
    const overflowY = window.getComputedStyle(node).overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * The index (document order) of the heading whose section currently sits at the
 * top of the reading area for the note rendered in the pane labelled
 * `Editing <path>` — the last heading whose top has scrolled to (or past) the
 * scroll container's top edge. Because it is position-based rather than a
 * top-band detector, the final heading activates correctly even when there is
 * no content below it to scroll further.
 *
 * Rows in the outline map to headings by this index, so duplicate heading text
 * is never ambiguous. Returns 0 before any scroll, when the note has no
 * headings, and while the editor's heading DOM has not yet been painted (it
 * re-computes as soon as it is, via a MutationObserver — no open-time race).
 */
export function useActiveHeading(path: string, headingCount: number): number {
  const [active, setActive] = useState(0)

  // Reset only when the note itself changes. Keying on `headingCount` too would
  // reset to 0 on every heading edit within the same note — the exact
  // live-editing case this feature tracks — and the out-of-range case is
  // already clamped by `Math.min(next, headingCount - 1)` in `compute`.
  const [previousPath, setPreviousPath] = useState(path)
  if (previousPath !== path) {
    setPreviousPath(path)
    setActive(0)
  }

  useEffect(() => {
    if (headingCount === 0) {
      return
    }
    const pane = window.document.querySelector(`[aria-label="Editing ${path}"]`)
    if (pane === null) {
      return
    }
    const root = pane.querySelector('.reflect-editor')
    if (root === null) {
      return
    }
    const scrollParent = findScrollParent(root)

    let frame = 0
    const compute = (): void => {
      frame = 0
      const nodes = root.querySelectorAll<HTMLElement>(HEADING_SELECTOR)
      if (nodes.length === 0) {
        return
      }
      const line =
        (scrollParent === null ? 0 : scrollParent.getBoundingClientRect().top) + ACTIVE_LINE_OFFSET
      let next = 0
      for (let index = 0; index < nodes.length; index += 1) {
        if (nodes[index]!.getBoundingClientRect().top <= line) {
          next = index
        } else {
          break
        }
      }
      setActive(Math.min(next, headingCount - 1))
    }
    const schedule = (): void => {
      if (frame === 0) {
        frame = window.requestAnimationFrame(compute)
      }
    }

    schedule()
    // scroll does not bubble; the capture phase catches it from whichever
    // container actually scrolls, so we never have to guess which one.
    window.document.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule, { passive: true })
    // Re-compute when the editor paints or edits its heading DOM: the open-time
    // race fix, plus live tracking as headings are added/removed/reordered.
    const mutations = new MutationObserver(schedule)
    mutations.observe(root, { childList: true, subtree: true })

    return () => {
      if (frame !== 0) {
        window.cancelAnimationFrame(frame)
      }
      window.document.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      mutations.disconnect()
    }
  }, [path, headingCount])

  return active
}
