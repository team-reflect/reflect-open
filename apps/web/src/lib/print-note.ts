/*
 * Prints one note, for the "Print Note…" command. Views tag each note's block
 * with `data-print-path` (a day in the daily stream, the column of a single
 * note). This marks the block for `path` as the print target and opens the
 * print dialog; the print styles in `styles/print.css` hide everything else.
 */

const TARGET_ATTRIBUTE = 'data-print-target'

/**
 * Open the print dialog for the note at `path`. Does nothing when the note is
 * not on screen.
 */
export function printNote(path: string): void {
  // The mark stays until the next print. Tauri's print opens a sheet and
  // returns before WebKit lays out the pages, so clearing it right after
  // could print the whole window.
  for (const element of document.querySelectorAll('[data-print-target]')) {
    element.removeAttribute(TARGET_ATTRIBUTE)
  }
  const target = document.querySelector(`[data-print-path="${CSS.escape(path)}"]`)
  if (target === null) {
    return
  }
  target.setAttribute(TARGET_ATTRIBUTE, '')
  window.print()
}
