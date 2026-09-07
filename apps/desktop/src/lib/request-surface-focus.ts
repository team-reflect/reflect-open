interface SurfaceFocusOptions extends FocusOptions {
  selectText?: boolean
  onFocused?: () => void
}

const INERT_SELECTOR = '[inert], [data-base-ui-inert], [aria-hidden="true"]'
const MODAL_SELECTOR = ':is([role="dialog"], [role="alertdialog"]):is([data-open], [data-closed])'

/**
 * Focus a newly arrived surface, waiting for an already-open modal to finish
 * closing when necessary. Only blocked requests observe the captured modal's
 * lifetime; cleanup cancels a request when its route or arrival is superseded.
 */
export function requestSurfaceFocus(
  element: HTMLElement | null,
  { selectText = false, onFocused, ...focusOptions }: SurfaceFocusOptions = {},
): () => void {
  const focus = (): void => {
    element?.focus(focusOptions)
    if (
      selectText &&
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ) {
      element.select()
    }
    onFocused?.()
  }
  if (element === null) return () => {}
  const inert = element.closest(INERT_SELECTOR) !== null
  if (!inert && element.closest(MODAL_SELECTOR) !== null) {
    focus()
    return () => {}
  }
  // Native inert marks mobile stack layers. Returning to that layer is a new
  // arrival, not permission to replay a focus gesture from the covered route.
  if (element.closest('[inert]') !== null) return () => {}

  const document = element.ownerDocument
  const blockers = [...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)].filter(
    (popup) => !popup.hidden && !popup.contains(element),
  )
  if (blockers.length === 0) {
    if (!inert) focus()
    return () => {}
  }
  const portals = blockers.map((popup) => popup.closest('[data-base-ui-portal]') ?? popup)
  const settled = (): boolean => blockers.every((popup) => !popup.isConnected || popup.hidden)
  let cancelled = false
  let frame: number | null = null
  let restoredFocus: EventTarget | null = null

  const cancel = (): void => {
    cancelled = true
    observer.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
    document.removeEventListener('pointerdown', onIntent, { capture: true })
    document.removeEventListener('keydown', onIntent, { capture: true })
    document.removeEventListener('focusin', onFocus, { capture: true })
  }
  const insideBlocker = (target: EventTarget | null): boolean =>
    target instanceof Node && portals.some((portal) => portal.contains(target))
  const onIntent = (event: Event): void => {
    if (!insideBlocker(event.target)) cancel()
  }
  const onFocus = (event: FocusEvent): void => {
    if (insideBlocker(event.target)) return
    // Base UI restores the old focus once after unmount. A later focus change
    // is newer intent and must win over the pending route request.
    if (!settled() || restoredFocus !== null) {
      cancel()
    } else {
      restoredFocus = event.target
    }
  }
  const observer = new MutationObserver(() => {
    if (cancelled || frame !== null || !settled()) return
    observer.disconnect()
    // Popup removal precedes Base UI's queued return-focus microtask. The next
    // frame orders the destination focus after that restoration, without
    // guessing the dialog's animation duration.
    frame = requestAnimationFrame(() => {
      if (cancelled) return
      cancel()
      if (
        element.isConnected &&
        element.closest(INERT_SELECTOR) === null &&
        ![...document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)].some(
          (popup) => !popup.hidden && !popup.contains(element),
        )
      ) {
        focus()
      }
    })
  })
  for (const popup of blockers) {
    for (
      let ancestor: HTMLElement | null = popup;
      ancestor !== null;
      ancestor = ancestor.parentElement
    ) {
      observer.observe(ancestor, { childList: true, attributes: true, attributeFilter: ['hidden'] })
    }
  }
  document.addEventListener('pointerdown', onIntent, { capture: true })
  document.addEventListener('keydown', onIntent, { capture: true })
  document.addEventListener('focusin', onFocus, { capture: true })
  return cancel
}
