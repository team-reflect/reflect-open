import { defineKeymap, type PlainExtension } from '@prosekit/core'
import { setBlockType } from '@prosekit/pm/commands'
import { TextSelection, type Command } from '@prosekit/pm/state'

/**
 * The central keymap registry (Plan 05 step 9). Every shortcut the app binds —
 * editor formatting here, navigation (Plan 06), `[[` autocomplete (Plan 07),
 * `⌘K` (Plan 08), the AI sidebar (Plan 10) — registers through {@link
 * registerKeymap}, which rejects duplicates so bindings can never silently
 * collide across features. Registration happens once at module scope; creating
 * editors reuses the registered map.
 */

export type KeymapScope = 'editor' | 'app'

const registeredBindings = new Map<string, KeymapScope>()

/**
 * Register `bindings` under `scope`, throwing on any already-taken key.
 * All-or-nothing: validation happens before any key is committed, so a
 * colliding batch never leaves the registry partially mutated.
 */
export function registerKeymap<T>(scope: KeymapScope, bindings: Record<string, T>): Record<string, T> {
  const keys = Object.keys(bindings)
  for (const key of keys) {
    const existing = registeredBindings.get(key)
    if (existing) {
      throw new Error(`duplicate keybinding "${key}": already registered by the ${existing} scope`)
    }
  }
  for (const key of keys) {
    registeredBindings.set(key, scope)
  }
  return bindings
}

/** Every registered binding (for the collision test + a future shortcuts UI). */
export function listRegisteredBindings(): ReadonlyMap<string, KeymapScope> {
  return registeredBindings
}

/**
 * Toggle an inline markdown marker (`**`, `_`, `` ` ``) around the selection.
 * meowdown keeps syntax as literal text, so toggling bold *is* inserting or
 * removing the marker characters — its inline pass restyles automatically.
 */
function toggleInlineMarker(marker: string): Command {
  return (state, dispatch) => {
    const { selection } = state
    if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)) {
      return false
    }
    const block = selection.$from.parent
    if (!block.isTextblock || block.type.spec.code) {
      return false
    }
    const { from, to, empty } = selection
    if (!dispatch) {
      return true
    }

    if (empty) {
      // Insert a marker pair and leave the caret between them.
      const tr = state.tr.insertText(marker + marker, from)
      tr.setSelection(TextSelection.create(tr.doc, from + marker.length))
      dispatch(tr)
      return true
    }

    const before = state.doc.textBetween(Math.max(0, from - marker.length), from)
    const after = state.doc.textBetween(to, Math.min(state.doc.content.size, to + marker.length))
    if (before === marker && after === marker) {
      // Unwrap: remove the surrounding markers (right side first so positions hold).
      const tr = state.tr.delete(to, to + marker.length).delete(from - marker.length, from)
      dispatch(tr)
      return true
    }

    // Wrap: insert at the end first so the start position is unaffected.
    const tr = state.tr.insertText(marker, to).insertText(marker, from)
    tr.setSelection(TextSelection.create(tr.doc, from + marker.length, to + marker.length))
    dispatch(tr)
    return true
  }
}

/**
 * Toggle the current block between `heading` at `level` and `paragraph`.
 * Headings are real nodes in meowdown (block syntax is reconstructed by the
 * serializer), so a block-type change round-trips exactly.
 */
function toggleHeading(level: number): Command {
  return (state, dispatch, view) => {
    const { heading, paragraph } = state.schema.nodes
    if (!heading || !paragraph) {
      return false
    }
    const { $from } = state.selection
    const isSame = $from.parent.type === heading && $from.parent.attrs.level === level
    const target = isSame ? setBlockType(paragraph) : setBlockType(heading, { level })
    return target(state, dispatch, view)
  }
}

/** Display descriptions for the editor-scope bindings (the shortcuts UI). */
export const EDITOR_BINDING_DESCRIPTIONS: Record<string, string> = {
  'Mod-b': 'Bold',
  'Mod-i': 'Italic',
  'Mod-e': 'Inline code',
  'Mod-1': 'Heading 1',
  'Mod-2': 'Heading 2',
  'Mod-3': 'Heading 3',
}

/** Reflect's editor-scope bindings — registered once, collision-checked. */
export const EDITOR_BINDINGS: Record<string, Command> = registerKeymap('editor', {
  'Mod-b': toggleInlineMarker('**'),
  'Mod-i': toggleInlineMarker('_'),
  'Mod-e': toggleInlineMarker('`'),
  'Mod-1': toggleHeading(1),
  'Mod-2': toggleHeading(2),
  'Mod-3': toggleHeading(3),
})

/** The editor keymap extension, composed into the editor via `union`. */
export function defineReflectKeymap(): PlainExtension {
  return defineKeymap(EDITOR_BINDINGS)
}
