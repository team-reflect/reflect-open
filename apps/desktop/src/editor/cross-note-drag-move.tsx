import { useEffect } from 'react'
import { useEditor } from '@meowdown/react'
import type { EditorExtension } from '@meowdown/core'

/**
 * Completes a *move* drag whose drop landed in a different note editor.
 *
 * The daily stream mounts one ProseMirror `EditorView` per day
 * (`daily-stream.tsx` → `NotePane` → `NoteEditor`), so dragging a task/block
 * from one day onto another is a drag *between two editor instances*.
 * ProseMirror only deletes the dragged content inside the view where the drop
 * lands: `editHandlers.drop` reads the *target* view's `view.dragging`, which
 * is `null` for a cross-view drop (only the source view recorded the drag), so
 * the drop computes `move = false` and merely inserts a copy. The source view
 * never sees a `drop` — its drag record is just cleared ~50ms later — so the
 * original stays put and the item is duplicated across both notes (issue #747).
 *
 * This bridge closes that gap. The drag is driven by ProseKit's block-handle
 * grip: a floating `<prosekit-block-handle-draggable>` element that lives
 * *outside* any `view.dom`, so its `dragstart`/`dragend` never reach a
 * per-view listener — only the target editor's `drop` fires on a `view.dom`.
 * So coordination happens at the **document** level instead, against a registry
 * of every mounted note view:
 *
 * - `dragstart` (bubbles up after the grip set `view.dragging` on the source
 *   view) records which registered view owns the in-flight drag.
 * - `drop` (bubbles up after the target editor's ProseMirror inserted the copy
 *   and called `preventDefault`) records which registered view received it.
 * - `dragend` (the source grip's, bubbling to document) runs the delete
 *   ProseMirror skipped when the drop landed in a *different* editor and the
 *   gesture was a move, using PM's own drag record (`dragging.node`, the same
 *   `NodeSelection.replace` a same-view move uses). `view.dragging` is still
 *   set at this point — the grip clears it 50ms after `dragend`.
 *
 * A cancelled drop (dropped outside every editor → no recorded target) or a
 * copy drag deletes nothing, so neither can lose the original. Every note
 * editor mounts its own instance; all share the module-level registry and drag
 * record below so the source and target instances can coordinate.
 */

/**
 * Minimal structural views of the ProseMirror pieces this bridge touches, so it
 * needs no direct `prosemirror-*` dependency. `dragging.node` is PM's internal
 * `Dragging.node` (a `NodeSelection` over the dragged block); it is not in
 * prosemirror-view's public `dragging` type but is the exact value PM itself
 * deletes for a same-view move, so mirroring it keeps the move semantics identical.
 */
interface DragTransaction {
  deleteSelection(): DragTransaction
  setMeta(key: string, value: unknown): DragTransaction
}
interface DragNodeSelection {
  replace(tr: DragTransaction): void
}
interface DragRecord {
  move: boolean
  node?: DragNodeSelection | null
}
interface DragView {
  readonly dom: HTMLElement
  readonly state: { readonly selection: { readonly empty: boolean }; readonly tr: DragTransaction }
  /** Writable, like PM's own `EditorView.dragging` — see the clear in `handleDragEnd`. */
  dragging: DragRecord | null
  dispatch(tr: DragTransaction): void
}

/**
 * What, if anything, the source editor must delete once a cross-editor move
 * settles. Split out as a pure decision so its edge cases — a cancelled drop, a
 * same-view move, a copy drag — are unit-testable without a live ProseMirror
 * view (the drag gesture itself is native and cannot run under jsdom).
 */
export type CrossNoteMoveDeletion = 'node' | 'selection' | 'none'

export function crossNoteMoveDeletion(input: {
  /** A source view was resolved for this drag (else the gesture is not ours). */
  isSourceView: boolean
  /** A drop landed, in a *different* editor than the source. */
  droppedInAnotherView: boolean
  /** The drag record's move flag — false for a copy drag (modifier held). */
  move: boolean
  /** The drag carried a `NodeSelection` (a block/task drag). */
  hasNode: boolean
  /** The source view's selection is empty (no text-selection range to remove). */
  selectionEmpty: boolean
}): CrossNoteMoveDeletion {
  if (!input.isSourceView || !input.droppedInAnotherView || !input.move) {
    return 'none'
  }
  if (input.hasNode) {
    return 'node'
  }
  return input.selectionEmpty ? 'none' : 'selection'
}

/** Every mounted note view, so a document-level drag can find source and target. */
const registeredViews = new Set<DragView>()
/** The in-flight drag's source view, and the view its drop landed in. */
let sourceView: DragView | null = null
let dropTargetView: DragView | null = null
/** Refcount so the single set of document listeners lives while any view is mounted. */
let listenerCount = 0

/** The registered view whose DOM contains `target`, if any. */
function viewContaining(target: EventTarget | null): DragView | null {
  if (!(target instanceof Node)) {
    return null
  }
  for (const view of registeredViews) {
    if (view.dom.contains(target)) {
      return view
    }
  }
  return null
}

/** The registered view holding a live PM drag record (the current drag's source). */
function viewWithLiveDrag(): DragView | null {
  for (const view of registeredViews) {
    if (view.dragging) {
      return view
    }
  }
  return null
}

function handleDragStart(): void {
  // The grip (or PM's native text-drag handler) has already set `view.dragging`
  // on the source view by the time this bubbles to document.
  sourceView = viewWithLiveDrag()
  dropTargetView = null
}

function handleDrop(event: DragEvent): void {
  // Bubbles up after the target editor's ProseMirror ran: `defaultPrevented`
  // means that editor accepted the drop and inserted, so deleting the source is
  // safe. A drop the target declined (or one outside every editor) records no
  // target, and the source is left untouched.
  dropTargetView = event.defaultPrevented ? viewContaining(event.target) : null
}

function handleDragEnd(): void {
  const source = sourceView ?? viewWithLiveDrag()
  const target = dropTargetView
  sourceView = null
  dropTargetView = null
  if (!source) {
    return
  }
  // Still set here — the grip clears `view.dragging` 50ms after dragend.
  const dragging = source.dragging
  // Same-view moves and cancelled drops are already correct (PM moved, or
  // nothing happened); a copy drag keeps the original in both notes.
  const deletion = crossNoteMoveDeletion({
    isSourceView: true,
    droppedInAnotherView: target !== null && target !== source,
    move: dragging?.move ?? false,
    hasNode: dragging?.node != null,
    selectionEmpty: source.state.selection.empty,
  })
  if (deletion === 'none') {
    return
  }
  const tr = source.state.tr
  if (deletion === 'node') {
    // The dragged block, as a NodeSelection. The source doc is untouched during
    // a cross-view drag, so these positions are still valid.
    dragging!.node!.replace(tr)
  } else {
    // A text-selection drag: its range in the source is likewise intact.
    tr.deleteSelection()
  }
  // Clear the drag record *before* dispatching. Our deletion changes the source
  // doc, and PM's `updateState` remaps a still-set `view.dragging` into a *new*
  // `Dragging` object (`updateDraggedNode`). That defeats the block handle's
  // clear guard — `if (view.dragging === original) view.dragging = null`, run
  // 50ms after dragend — so the source would be left permanently "dragging" and
  // `viewWithLiveDrag` would misidentify it as the source of the *next* drag,
  // duplicating that drag instead of moving it (issue #747, the move-back case).
  source.dragging = null
  source.dispatch(tr.setMeta('uiEvent', 'drop'))
}

function addDocumentListeners(): void {
  if (listenerCount++ > 0) {
    return
  }
  document.addEventListener('dragstart', handleDragStart)
  document.addEventListener('drop', handleDrop)
  document.addEventListener('dragend', handleDragEnd)
}

function removeDocumentListeners(): void {
  if (--listenerCount > 0) {
    return
  }
  document.removeEventListener('dragstart', handleDragStart)
  document.removeEventListener('drop', handleDrop)
  document.removeEventListener('dragend', handleDragEnd)
}

export function CrossNoteDragMove(): null {
  const editor = useEditor<EditorExtension>()

  useEffect(() => {
    let frame: number | null = null
    let registered: DragView | null = null

    // Same mount dance as FormattingToolbarBridge: ProseKit attaches the view
    // via ref before effects run, so this attaches immediately in practice —
    // but the timing is ProseKit's, so retry per frame until it is mounted.
    const attach = (): void => {
      if (!editor.mounted) {
        frame = requestAnimationFrame(attach)
        return
      }
      frame = null
      registered = editor.view as unknown as DragView
      registeredViews.add(registered)
      addDocumentListeners()
    }
    attach()

    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (!registered) {
        return
      }
      registeredViews.delete(registered)
      // Drop any dangling reference to this torn-down view so a stale record
      // can't fire a delete on an unmounted editor.
      if (sourceView === registered) {
        sourceView = null
      }
      if (dropTargetView === registered) {
        dropTargetView = null
      }
      removeDocumentListeners()
    }
  }, [editor])

  return null
}
