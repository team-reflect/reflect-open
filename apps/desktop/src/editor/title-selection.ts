import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import { TextSelection, type Command } from '@prosekit/pm/state'

/**
 * Title selection for the new-note flow (non-daily notes): a missing note
 * opens seeded with an `# Untitled` heading, and selecting that word lets the
 * first keystroke name the note — the macOS rename pattern, mirroring old
 * Reflect's focus-the-subject behavior on create.
 */

/**
 * The document range of the first top-level heading's text, or `null` when
 * the document has no titled heading to select.
 */
export function firstHeadingTextRange(
  doc: ProseMirrorNode,
): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null
  doc.forEach((node, offset) => {
    if (range === null && node.type.name === 'heading' && node.content.size > 0) {
      range = { from: offset + 1, to: offset + 1 + node.content.size }
    }
  })
  return range
}

/**
 * Select the first heading's text so typing replaces it. Returns false (and
 * dispatches nothing) when the document has no titled heading — callers fall
 * back to a plain focus.
 */
export const selectFirstHeadingText: Command = (state, dispatch) => {
  const range = firstHeadingTextRange(state.doc)
  if (range === null) {
    return false
  }
  dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, range.from, range.to)))
  return true
}
