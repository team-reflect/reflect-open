import { useEffect } from 'react'
import { useEditor } from '@meowdown/react'
import { DOMSerializer } from '@prosekit/pm/model'

const BLOCK_HANDLE_SELECTOR = 'prosekit-block-handle-draggable'

function isBlockHandleEvent(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest(BLOCK_HANDLE_SELECTOR) !== null
  )
}

/**
 * Give block-handle drags a ProseMirror-native clipboard envelope. ProseKit's
 * handle only supplies the rendered block HTML; that is enough
 * inside one editor, where `view.dragging` carries the source slice, but a drop
 * into another editor parses the HTML as foreign content. In the daily stream
 * that turned task-list DOM into a literal `\[ ]` paragraph and detached task
 * text. The serialized payload carries `data-pm-slice`, so another mounted note
 * can reconstruct the original block without passing it through rich-HTML
 * conversion. This only makes the transfer lossless; ProseMirror continues to
 * treat drops between editor views as copies.
 */
export function BlockDragClipboard(): null {
  const editor = useEditor()

  useEffect(() => {
    let frame: number | null = null
    let removeListener: (() => void) | null = null

    const attach = (): void => {
      if (!editor.mounted) {
        frame = requestAnimationFrame(attach)
        return
      }

      frame = null
      const view = editor.view
      const wrapper = view.dom.closest('.meowdown')
      if (wrapper === null) {
        return
      }

      const handleDragStart = (event: Event): void => {
        const dragEvent = event as DragEvent
        if (dragEvent.dataTransfer === null) {
          return
        }
        if (!isBlockHandleEvent(event)) {
          return
        }

        // ProseKit's listener runs on the draggable handle before this bubbling
        // listener, so it has already selected the block and populated
        // `view.dragging` with the exact source slice.
        const dragging = view.dragging
        if (dragging === null) {
          return
        }

        const serialized = view.serializeForClipboard(dragging.slice)
        const sliceMetadata = serialized.dom
          .querySelector('[data-pm-slice]')
          ?.getAttribute('data-pm-slice')
        if (sliceMetadata === null || sliceMetadata === undefined) {
          return
        }

        // The flat-list clipboard serializer normalizes list markers, which
        // would turn Reflect's round `+ [ ]` task into a plain `- [ ]`
        // checklist. Serialize through the full Meowdown schema to retain its
        // marker attributes, then reuse ProseMirror's own slice metadata.
        const container = view.dom.ownerDocument.createElement('div')
        container.append(
          DOMSerializer.fromSchema(view.state.schema).serializeFragment(
            serialized.slice.content,
            { document: view.dom.ownerDocument },
          ),
        )
        const firstElement = container.firstElementChild
        if (firstElement === null) {
          return
        }
        firstElement.setAttribute('data-pm-slice', sliceMetadata)

        dragEvent.dataTransfer.setData('text/html', container.innerHTML)
        dragEvent.dataTransfer.setData('text/plain', serialized.text)
        view.dragging = { ...dragging, slice: serialized.slice }
      }

      const handleDragEnd = (event: Event): void => {
        if (isBlockHandleEvent(event)) {
          // The handle lives outside `view.dom`, so ProseMirror's own dragend
          // handler never clears this source-view state after a cross-editor
          // drop or a canceled drag.
          view.dragging = null
        }
      }

      wrapper.addEventListener('dragstart', handleDragStart)
      wrapper.addEventListener('dragend', handleDragEnd)
      removeListener = () => {
        wrapper.removeEventListener('dragstart', handleDragStart)
        wrapper.removeEventListener('dragend', handleDragEnd)
      }
    }

    attach()
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      removeListener?.()
    }
  }, [editor])

  return null
}
