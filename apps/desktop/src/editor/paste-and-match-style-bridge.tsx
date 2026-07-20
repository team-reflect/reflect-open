import { useEffect } from 'react'
import { useEditor } from '@meowdown/react'
import type { EditorExtension } from '@meowdown/core'
import { hasBridge, subscribePasteAndMatchStyle } from '@reflect/core'
import { trackSubscriptions } from '@/lib/subscriptions'

/**
 * Runs the shell menu's Edit > "Paste and Match Style" (⌘⇧V) in this editor
 * while it holds focus. The accelerator is an app-menu key equivalent, so the
 * webview never sees the keystroke; the Rust handler reads the pasteboard and
 * targets the focused window with the plain text (`menu.rs`), and the focused
 * editor feeds it through `view.pasteText` — ProseMirror's plain-text paste
 * path, the same one a browser Shift-paste takes. Mounted inside the editor's
 * ProseKit context like `EditorInputTraits`; a no-op without a native shell.
 */
export function PasteAndMatchStyleBridge(): null {
  const editor = useEditor<EditorExtension>()

  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    const tracker = trackSubscriptions()
    void tracker.add(
      subscribePasteAndMatchStyle((text) => {
        if (!editor.mounted || !editor.focused) {
          return
        }
        editor.view.pasteText(text)
      }),
    )
    return () => tracker.disposeAll()
  }, [editor])

  return null
}
