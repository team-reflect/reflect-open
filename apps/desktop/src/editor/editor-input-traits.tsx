import { useEffect } from 'react'
import { useEditor } from '@meowdown/react'
import { isTouchEditorSurface } from '@/editor/touch-surface'

/**
 * iOS text-input hygiene on the editing surface (Plan 19, decision 7 — a gate
 * criterion, not polish). Mounted inside the editor's ProseKit context, it
 * sets the software keyboard's input traits on the contenteditable
 * deliberately instead of inheriting WebKit defaults:
 *
 * - `autocapitalize="sentences"` — notes are prose; sentence capitalization
 *   is wanted (and stated, so a future change is a decision, not an accident).
 * - `autocorrect="on"` — typo correction stays. On iOS this does NOT enable
 *   smart punctuation: WebKit derives the smart-quotes/smart-dashes keyboard
 *   traits from the element's **spellcheck** flag at focus time
 *   (`WKContentViewInteraction`), which `NoteEditor` pins to `false` on the
 *   touch surface so `“”`/`—` substitutions can never corrupt `[[` wiki
 *   links, code spans, or `---` fences.
 *
 * ProseMirror leaves attributes it didn't create alone, so a one-time write
 * per editor mount sticks. No-op on desktop.
 */
export function EditorInputTraits(): null {
  const editor = useEditor()

  useEffect(() => {
    if (!isTouchEditorSurface()) {
      return
    }
    // ProseKit attaches the view via ref before effects run, so this applies
    // immediately in practice — but the mount timing is ProseKit's, not ours,
    // so a not-yet-mounted editor is retried per frame instead of skipped.
    let frame: number | null = null
    const apply = (): void => {
      if (!editor.mounted) {
        frame = requestAnimationFrame(apply)
        return
      }
      frame = null
      const dom = editor.view.dom
      dom.setAttribute('autocapitalize', 'sentences')
      dom.setAttribute('autocorrect', 'on')
    }
    apply()
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [editor])

  return null
}
