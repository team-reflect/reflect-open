export interface LinkOpacityToScrollOptions {
  /**
   * The element whose opacity follows the scroll. It may sit anywhere in the document.
   */
  target: HTMLElement
  /**
   * The element whose scroll position drives the opacity.
   */
  scroller: HTMLElement
  /**
   * The scroll axis that drives the opacity.
   */
  axis: 'x' | 'y'
  /**
   * The scroll offset (px) where the opacity starts to move from `from`.
   */
  start: number
  /**
   * The opacity at `start` and before.
   */
  from: number
  /**
   * The opacity at the end of the scroll range.
   */
  to: number
  /**
   * Ends the link. The opacity then returns to the stylesheet's.
   */
  signal: AbortSignal
}

/**
 * Ties `target`'s opacity to how far `scroller` has scrolled past `start`:
 * `from + (to - from) * (position - start) / (range - start)`. A WAAPI
 * `ScrollTimeline` drives it where the engine has one (iOS 26+); elsewhere a
 * `scroll` listener writes it.
 */
export function linkOpacityToScroll({
  target,
  scroller,
  axis,
  start,
  from,
  to,
  signal,
}: LinkOpacityToScrollOptions): void {
  if (signal.aborted) {
    return
  }
  if (typeof ScrollTimeline === 'function') {
    const animation = target.animate(
      { opacity: [from, to] },
      {
        timeline: new ScrollTimeline({ source: scroller, axis }),
        fill: 'both',
        // A string: Chromium ignores a `CSS.px()` value here.
        rangeStart: `${start}px`,
      },
    )
    signal.addEventListener('abort', () => animation.cancel(), { once: true })
    return
  }
  const inline = target.style.opacity
  const paint = (): void => {
    const range =
      axis === 'x'
        ? scroller.scrollWidth - scroller.clientWidth
        : scroller.scrollHeight - scroller.clientHeight
    const position = axis === 'x' ? scroller.scrollLeft : scroller.scrollTop
    const span = range - start
    const progress = span > 0 ? Math.min(1, Math.max(0, (position - start) / span)) : 0
    target.style.opacity = String(from + (to - from) * progress)
  }
  paint()
  scroller.addEventListener('scroll', paint, { passive: true, signal })
  signal.addEventListener('abort', () => (target.style.opacity = inline), { once: true })
}
