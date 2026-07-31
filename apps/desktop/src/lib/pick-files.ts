/** Options for {@link pickFiles}. */
export interface PickFilesOptions {
  /** The picker's `accept` list, e.g. `image/*`. Omitted offers every type. */
  accept?: string
  /** Whether more than one file can be chosen. */
  multiple?: boolean
}

/**
 * Open the webview's own file picker and resolve with the chosen files (empty
 * when it is dismissed).
 *
 * The input is created on `document.body` instead of being rendered by the
 * calling component on purpose: on iOS the picker takes over the screen and
 * drops the software keyboard, and the mobile shell swaps the whole
 * formatting toolbar out for the tab bar while the keyboard is down — a
 * toolbar-owned input would be torn out of the DOM with the sheet still open,
 * losing its `change` event. A detached input outlives its caller.
 *
 * Must be called from a user gesture's own call stack: `click()` on a file
 * input needs the activation, so callers cannot await anything first.
 */
export function pickFiles({ accept, multiple = false }: PickFilesOptions = {}): Promise<File[]> {
  const input = document.createElement('input')
  input.type = 'file'
  if (accept !== undefined) {
    input.accept = accept
  }
  input.multiple = multiple
  input.style.display = 'none'
  document.body.append(input)

  return new Promise<File[]>((resolve) => {
    const settle = (files: File[]): void => {
      input.remove()
      resolve(files)
    }
    input.addEventListener('change', () => settle([...(input.files ?? [])]), { once: true })
    // `cancel` is WebKit 16.4+ and the app's deployment target is iOS 14, so
    // on older webviews a dismissal leaves the input attached until the next
    // pick collects it. Cleanup, never correctness.
    input.addEventListener('cancel', () => settle([]), { once: true })
    input.click()
  })
}
