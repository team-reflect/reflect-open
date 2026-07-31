import { useEffect, useLayoutEffect, useRef } from 'react'
import { useEditor } from '@meowdown/react'
import { buildFileMarkdown, type EditorExtension } from '@meowdown/core'
import { toPortableImageFile } from '@/lib/image-file'
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
 *
 * The command surface also carries `scrollCaretIntoView` for the keyboard's
 * caret reveal; no toolbar button calls it.
 *
 * `saveFile` is the same handler meowdown gets for paste and drop, so the
 * toolbar's attach button persists files down the one path and inserts the
 * markdown a paste would have inserted. Editors without one publish
 * `canAttachFiles: false` and the toolbar leaves the button out.
 */
export function FormattingToolbarBridge({
  saveFile,
}: {
  /** Persist a file and resolve its markdown destination (undefined declines). */
  saveFile?: (file: File) => Promise<string | undefined>
}): null {
  const editor = useEditor<EditorExtension>()
  // Read through a ref like the editor's other host callbacks: a changing
  // identity must not tear down and re-attach the published toolbar.
  const saveFileRef = useRef(saveFile)
  useLayoutEffect(() => {
    saveFileRef.current = saveFile
  }, [saveFile])
  const canAttachFiles = saveFile !== undefined

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
          canAttachFiles,
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
        cycleBulletOrderedList: () => run(() => editor.commands.cycleBulletOrderedList()),
        cycleCheckableList: () => run(() => editor.commands.cycleCheckableList()),
        indent: () => run(() => editor.commands.indentList()),
        dedent: () => run(() => editor.commands.dedentList()),
        moveUp: () => run(() => editor.commands.moveList('up')),
        moveDown: () => run(() => editor.commands.moveList('down')),
        insertTrigger: (text: FormattingTriggerText) =>
          run(() => editor.commands.insertTrigger(text)),
        dismissKeyboard: () => editor.blur(),
        attachFiles: async (files: File[]) => {
          const save = saveFileRef.current
          if (save === undefined) {
            return
          }
          const markdown: string[] = []
          for (const picked of files) {
            const file = await toPortableImageFile(picked)
            // `saveFile` owns its failures (it resolves undefined and the
            // pane raises the banner), so a file that did not land is
            // skipped and the ones that did are still linked.
            const destination = await save(file)
            if (destination !== undefined) {
              markdown.push(buildFileMarkdown(file, destination))
            }
          }
          // The picker outlives the keyboard, and on iOS the sheet took focus
          // away to open — refocusing puts the caret (and the keyboard) back
          // where the tap left them, and the insert lands there.
          if (markdown.length === 0 || !editor.mounted) {
            return
          }
          editor.focus()
          run(() => editor.commands.insertMarkdown(markdown.join('\n')))
        },
        // Not wrapped in `run()`: this never changes the document. Skipped
        // mid-composition, where a dispatch would end the composition and eat
        // a half-typed CJK character.
        scrollCaretIntoView: () => {
          if (editor.view.composing) {
            return
          }
          editor.commands.scrollIntoView()
        },
      }

      // `selectionchange` (and the focus that a caret-placing tap raises)
      // fires before ProseMirror ingests the new DOM selection into its
      // state (the ingest runs on a deferred flush, up to ~20ms later), so an
      // immediate `canExec` read computes capabilities for the previous caret
      // position. Coalesce each burst and publish after the ingest window.
      let publishTimer: ReturnType<typeof setTimeout> | undefined
      function publishAfterSelectionSync(): void {
        if (publishTimer !== undefined) {
          clearTimeout(publishTimer)
        }
        publishTimer = setTimeout(() => {
          publishTimer = undefined
          if (editor.focused) {
            publish()
          }
        }, 32)
      }

      function handleFocusIn(): void {
        publishAfterSelectionSync()
      }
      function handleFocusOut(): void {
        clearFormattingToolbar(owner)
      }
      function handleSelectionChange(): void {
        if (editor.focused) {
          publishAfterSelectionSync()
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
        if (publishTimer !== undefined) {
          clearTimeout(publishTimer)
        }
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
    // `canAttachFiles` is fixed per editor in practice (a pane either has a
    // saveFile or does not), so re-attaching on a flip costs nothing and
    // keeps the published capability honest.
  }, [editor, canAttachFiles])

  return null
}
