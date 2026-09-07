interface SurfaceFocusOptions extends FocusOptions {
  selectText?: boolean
  onFocused?: () => void
}

const INERT_SELECTOR = '[inert], [aria-hidden="true"]'
const MODAL_SELECTOR = ':is([role="dialog"], [role="alertdialog"])[data-open]'
const INTENT_EVENTS = ['pointerdown', 'keydown', 'focusin'] as const

/**
 * Focuses a newly arrived surface, waiting for any open dialog to close first
 * and cancelling if the user acts before then. A dialog that is already closing
 * does not block, because Base UI removes `aria-hidden` from outside elements as
 * soon as `open` flips false and does not return focus to the trigger when focus
 * has already moved elsewhere.
 */
export function requestSurfaceFocus(
  element: HTMLElement | null,
  { selectText = false, onFocused, ...focusOptions }: SurfaceFocusOptions = {},
): () => void {
  if (element === null) return () => {}
  const focus = (): void => {
    element.focus(focusOptions)
    if (
      selectText &&
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ) {
      element.select()
    }
    onFocused?.()
  }
  const inert = element.closest(INERT_SELECTOR) !== null
  if (!inert && element.closest(MODAL_SELECTOR) !== null) {
    focus()
    return () => {}
  }
  // Native inert marks mobile stack layers. Returning to that layer is a new
  // arrival, not permission to replay a focus gesture from the covered route.
  if (element.closest('[inert]') !== null) return () => {}

  const document = element.ownerDocument
  const openDialogs = (): HTMLElement[] =>
    [...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)].filter(
      (popup) => !popup.contains(element),
    )
  const blockers = openDialogs()
  if (blockers.length === 0) {
    if (!inert) focus()
    return () => {}
  }
  const settled = (): boolean =>
    blockers.every((popup) => !popup.isConnected || !popup.hasAttribute('data-open'))
  const insideBlocker = (target: EventTarget | null): boolean =>
    target instanceof Node && blockers.some((popup) => popup.contains(target))
  let frame: number | null = null

  const cancel = (): void => {
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
    for (const type of INTENT_EVENTS) {
      document.removeEventListener(type, onIntent, { capture: true })
    }
  }
  const onIntent = (event: Event): void => {
    if (!insideBlocker(event.target)) cancel()
  }
  const observer = new MutationObserver(() => {
    if (!settled()) return
    cancel()
    frame = requestAnimationFrame(() => {
      if (
        element.isConnected &&
        element.closest(INERT_SELECTOR) === null &&
        openDialogs().length === 0
      ) {
        focus()
      }
    })
  })
  for (const popup of blockers) {
    observer.observe(popup, { attributes: true, attributeFilter: ['data-open'] })
    for (let ancestor = popup.parentNode; ancestor !== null; ancestor = ancestor.parentNode) {
      observer.observe(ancestor, { childList: true })
    }
  }
  for (const type of INTENT_EVENTS) document.addEventListener(type, onIntent, { capture: true })
  return cancel
}
