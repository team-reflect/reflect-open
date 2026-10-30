export interface LinkOpacityToScrollOptions {
  /** The element whose opacity follows the scroll. It may sit anywhere in the document. */
  target: HTMLElement
  /** The element whose scroll position drives the opacity. */
  scroller: HTMLElement
  /** The scroll axis that drives the opacity. */
  axis: 'x' | 'y'
  /** The opacity at scroll position 0. */
  from: number
  /** The opacity at the end of the scroll range. */
  to: number
  /** Ends the link. The opacity then returns to the stylesheet's. */
  signal: AbortSignal
}

/**
 * Ties `target`'s opacity to how far `scroller` has scrolled:
 * `from + (to - from) * position / range`, driven by a WAAPI
 * `ScrollTimeline`. Where the engine has no `ScrollTimeline`, it does nothing.
 */
export function linkOpacityToScroll({
  target,
  scroller,
  axis,
  from,
  to,
  signal,
}: LinkOpacityToScrollOptions): void {
  if (signal.aborted || typeof ScrollTimeline !== 'function') {
    return
  }
  const animation = target.animate(
    { opacity: [from, to] },
    { timeline: new ScrollTimeline({ source: scroller, axis }), fill: 'both' },
  )
  signal.addEventListener('abort', () => animation.cancel(), { once: true })
}
