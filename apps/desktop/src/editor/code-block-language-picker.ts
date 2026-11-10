import type { useEditor } from '@meowdown/react'

type EditorView = ReturnType<typeof useEditor>['view']

/** Meowdown's language combobox trigger in a code block's toolbar (its own tests address it this way). */
const LANGUAGE_TRIGGER = '[data-testid="code-block-language"]'

/**
 * Hands focus back to the editor when the picker closes, so the caret is where the user left it.
 * The toolbar carries `data-open` while the picker is open. Base UI returns focus to the trigger
 * just after that attribute clears, so the check waits a frame. When the user closed the picker
 * by moving elsewhere (clicking another control), focus is left there.
 */
function refocusEditorOnClose(view: EditorView, toolbar: HTMLElement): void {
  const observer = new MutationObserver(() => {
    if (toolbar.hasAttribute('data-open')) return
    observer.disconnect()
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === null || active === document.body || toolbar.contains(active)) view.focus()
    })
  })
  observer.observe(toolbar, { attributes: true, attributeFilter: ['data-open'] })
}

/**
 * Opens the "Search or type a language" picker of the code block holding the selection, as if
 * its toolbar button were clicked. Returns false, so the key falls through, when the selection
 * is not inside a single code block.
 */
export function openCodeBlockLanguagePicker(view: EditorView): boolean {
  const { $from, $to } = view.state.selection
  if ($from.parent.type.name !== 'codeBlock' || !$from.sameParent($to)) return false
  const block = view.nodeDOM($from.before())
  const trigger =
    block instanceof HTMLElement ? block.querySelector<HTMLElement>(LANGUAGE_TRIGGER) : null
  const toolbar = trigger?.parentElement
  if (!trigger || !toolbar) return false
  refocusEditorOnClose(view, toolbar)
  trigger.click()
  return true
}
