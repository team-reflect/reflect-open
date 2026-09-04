/**
 * Focus a surface only while it can receive interaction. A route may finish
 * loading behind a modal or a mobile stack card; Base UI marks that background
 * inert with data attributes rather than the browser's native `inert` flag.
 */
export function focusUnlessInert(element: HTMLElement | null, options?: FocusOptions): boolean {
  if (
    element === null ||
    element.closest('[inert], [data-base-ui-inert], [aria-hidden="true"]') !== null
  ) {
    return false
  }
  element.focus(options)
  return true
}
