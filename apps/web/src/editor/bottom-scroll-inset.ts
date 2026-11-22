import { definePlugin } from '@prosekit/core'
import { Plugin } from '@prosekit/pm/state'

/**
 * ProseMirror's default `scrollMargin`.
 */
const SCROLL_MARGIN = 5

const scrollThreshold = { top: 0, right: 0, bottom: 0, left: 0 }
const scrollMargin = {
  top: SCROLL_MARGIN,
  right: SCROLL_MARGIN,
  bottom: SCROLL_MARGIN,
  left: SCROLL_MARGIN,
}

/**
 * Sets the height at the bottom of the editor's scroll container that a view
 * over it covers, in CSS pixels.
 */
export function setBottomScrollInset(inset: number): void {
  scrollThreshold.bottom = inset
  scrollMargin.bottom = SCROLL_MARGIN + inset
}

/**
 * Keeps the caret that ProseMirror scrolls into view above the inset of
 * {@link setBottomScrollInset}.
 */
export const bottomScrollInsetExtension = /* @__PURE__ */ definePlugin(
  new Plugin({ props: { scrollThreshold, scrollMargin } }),
)
