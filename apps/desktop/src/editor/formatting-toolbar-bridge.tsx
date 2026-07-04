import { useEffect } from 'react'
import { useEditor } from '@meowdown/react'
import type { EditorExtension } from '@meowdown/core'
import { isTouchEditorSurface } from '@/lib/platform-surface'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
  type FormattingToolbarCapabilities,
  type FormattingToolbarCommands,
  type FormattingTriggerText,
} from './formatting-toolbar-store'

/**
 * Publishes this editor's formatting-toolbar surface while it holds focus
 * (Plan 19, decision 8: the toolbar is webview-drawn, and V1's item set with
 * selection-aware enablement is the spec). Mounted inside the editor's
 * ProseKit context like `EditorInputTraits`; a no-op off the touch surface.
 *
 * Deliberately not `useEditor({ update: true })` — that option is
 * incompatible with the React Compiler — nor a widening of
 * `NoteEditorHandle`: commands close over the ProseKit editor instance and
 * flow out through the module store, so the toolbar never needs to know
 * which of the carousel's mounted editors is focused.
 *
 * Capabilities recompute on DOM `selectionchange` (WebKit fires it for every
 * caret move in the contenteditable) and after each toolbar command, whose
 * own document change is not guaranteed to move the DOM selection.
 */
export function FormattingToolbarBridge(): null {
  const editor = useEditor<EditorExtension>()

  useEffect(() => {
    if (!isTouchEditorSurface()) {
      return
    }
    const owner = Symbol('formatting-toolbar')
    let frame: number | null = null
    let teardown: (() => void) | null = null

    // Same mount dance as EditorInputTraits: ProseKit attaches the view via
    // ref before effects run, so this attaches immediately in practice — but
    // the timing is ProseKit's, so a not-yet-mounted editor retries per frame.
    const attach = (): void => {
      if (!editor.mounted) {
        frame = requestAnimationFrame(attach)
        return
      }
      frame = null
      const dom = editor.view.dom

      function readCapabilities(): FormattingToolbarCapabilities {
        return {
          canIndent: editor.commands.indentList.canExec(),
          canDedent: editor.commands.dedentList.canExec(),
          canMoveUp: editor.commands.moveList.canExec('up'),
          canMoveDown: editor.commands.moveList.canExec('down'),
        }
      }

      function publish(): void {
        publishFormattingToolbar(owner, { capabilities: readCapabilities(), commands })
      }

      function run(command: () => void): void {
        command()
        publish()
      }

      const commands: FormattingToolbarCommands = {
        toggleBulletList: () => run(() => editor.commands.toggleList({ kind: 'bullet' })),
        toggleTaskList: () => run(() => editor.commands.toggleList({ kind: 'task' })),
        indent: () => run(() => editor.commands.indentList()),
        dedent: () => run(() => editor.commands.dedentList()),
        moveUp: () => run(() => editor.commands.moveList('up')),
        moveDown: () => run(() => editor.commands.moveList('down')),
        insertTrigger: (text: FormattingTriggerText) =>
          run(() => editor.commands.insertTrigger(text)),
        dismissKeyboard: () => editor.blur(),
      }

      function handleFocusIn(): void {
        publish()
      }
      function handleFocusOut(): void {
        clearFormattingToolbar(owner)
      }
      function handleSelectionChange(): void {
        if (editor.focused) {
          publish()
        }
      }

      dom.addEventListener('focusin', handleFocusIn)
      dom.addEventListener('focusout', handleFocusOut)
      document.addEventListener('selectionchange', handleSelectionChange)
      // autoFocus can land before these listeners attach (the arrival-intent
      // focus fires on editor mount) — an already-focused editor publishes now.
      if (editor.focused) {
        publish()
      }
      teardown = () => {
        dom.removeEventListener('focusin', handleFocusIn)
        dom.removeEventListener('focusout', handleFocusOut)
        document.removeEventListener('selectionchange', handleSelectionChange)
        clearFormattingToolbar(owner)
      }
    }
    attach()
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      teardown?.()
    }
  }, [editor])

  return null
}
