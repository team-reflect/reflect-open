/** The scroller's page width, unrounded (`clientWidth` is a whole number). */
export function pageWidth(scroller: HTMLElement): number {
  return scroller.getBoundingClientRect().width
}

/** The page nearest the scroller's offset, or `undefined` before layout. */
export function nearestIndex(scroller: HTMLElement, count: number): number | undefined {
  const width = pageWidth(scroller)
  if (width === 0) {
    return undefined
  }
  return Math.min(count - 1, Math.max(0, Math.round(scroller.scrollLeft / width)))
}

/** Moves the scroller onto page `index` at once, unless it is already there. */
export function restOn(scroller: HTMLElement, index: number): void {
  const left = index * pageWidth(scroller)
  if (Math.abs(scroller.scrollLeft - left) >= 1) {
    scroller.scrollTo({ left, behavior: 'instant' })
  }
}

/**
 * The page that holds `target`, from its position in the scroll range: pages
 * may sit under a wrapper, so the scroller's children do not name them.
 * `undefined` before layout.
 */
export function pageOf(scroller: HTMLElement, target: Element, count: number): number | undefined {
  const width = pageWidth(scroller)
  if (width === 0) {
    return undefined
  }
  const rect = target.getBoundingClientRect()
  const center = rect.left + rect.width / 2 - scroller.getBoundingClientRect().left
  return Math.min(count - 1, Math.max(0, Math.floor((scroller.scrollLeft + center) / width)))
}
