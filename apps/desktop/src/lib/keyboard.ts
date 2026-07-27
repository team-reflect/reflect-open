let isComposing = false
let timer : ReturnType<typeof setTimeout> | undefined

// Workaround for a bug in WebKit where the isComposing property is reset to false event when the IME is still composing.
// https://bugs.webkit.org/show_bug.cgi?id=311717
export function isKeyboardEventComposing(event: KeyboardEvent): boolean {


  if (event.isComposing) {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    isComposing = true
  } else if (isComposing) {
    timer = setTimeout(() => {
      isComposing = false
      timer = undefined
    }, 40)
  }

  return isComposing
}
