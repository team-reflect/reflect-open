const COMPOSITION_TAIL_MS = 40

let lastCompositionEndedAt = -Infinity

if (typeof window !== 'undefined') {
  window.addEventListener(
    'compositionend',
    (event) => {
      lastCompositionEndedAt = event.timeStamp
    },
    true,
  )
}

// Workaround for WebKit firing compositionend before the keydown that commits an
// IME composition, which makes that keydown report `isComposing` as false.
// https://bugs.webkit.org/show_bug.cgi?id=165004
// https://bugs.webkit.org/show_bug.cgi?id=311717
export function isKeyboardEventComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.timeStamp - lastCompositionEndedAt < COMPOSITION_TAIL_MS
}
