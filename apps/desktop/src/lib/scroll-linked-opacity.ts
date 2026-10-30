export interface ScrollLinkedOpacity {
  /** The scroll axis that drives the opacity. */
  axis: 'x' | 'y'
  /** The opacity at scroll position 0. */
  from: number
  /** The opacity at the end of the scroll range. */
  to: number
}

/**
 * Ties `target`'s opacity to how far `scroller` has scrolled:
 * `from + (to - from) * position / range`. With `ScrollTimeline` (iOS 26+)
 * the engine drives it; elsewhere a passive `scroll` listener writes
 * `style.opacity`. `target` may sit anywhere in the document. The link ends,
 * and the opacity returns to the stylesheet's, when `signal` aborts.
 */
export function linkOpacityToScroll(
  target: HTMLElement,
  scroller: HTMLElement,
  { axis, from, to }: ScrollLinkedOpacity,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    return
  }
  if (typeof ScrollTimeline === 'function') {
    const animation = target.animate(
      { opacity: [from, to] },
      { timeline: new ScrollTimeline({ source: scroller, axis }), fill: 'both' },
    )
    signal.addEventListener('abort', () => animation.cancel(), { once: true })
    return
  }

  const paint = (): void => {
    const range =
      axis === 'x'
        ? scroller.scrollWidth - scroller.clientWidth
        : scroller.scrollHeight - scroller.clientHeight
    const position = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop
    const progress = range > 0 ? Math.min(1, Math.max(0, position / range)) : 0
    target.style.opacity = String(from + (to - from) * progress)
  }
  paint()
  scroller.addEventListener('scroll', paint, { passive: true, signal })
  // The range moves when the scroller or its content resizes, with no scroll event.
  const resize = new ResizeObserver(paint)
  resize.observe(scroller)
  for (const child of scroller.children) {
    resize.observe(child)
  }
  signal.addEventListener(
    'abort',
    () => {
      resize.disconnect()
      target.style.removeProperty('opacity')
    },
    { once: true },
  )
}
