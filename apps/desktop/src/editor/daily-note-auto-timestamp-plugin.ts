import { format } from 'date-fns'
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state'

/**
 * A ProseMirror plugin that prefixes a top-level bullet line with the current
 * time (`` `HH:mm`  ``) at the moment the user's *first* character lands in
 * that bullet. Semantics:
 *
 * - Fires when a focused top-level bullet paragraph transitions from empty to
 *   non-empty — so the trigger is "you just started writing this bullet",
 *   whether the character came from a keystroke, a paste, or an IME
 *   composition (which surfaces as a single transaction on `compositionend`).
 * - Only inside daily notes (the caller mounts the extension conditionally).
 * - Only on top-level bullet-list items (kind `'bullet'`) — task lists,
 *   ordered lists, nested lists, headings, paragraphs, and code blocks are
 *   left untouched.
 * - Idempotent: if the paragraph's first character is a backtick, no stamp is
 *   inserted (the user has typed their own timestamp or an inline code span,
 *   and either way we should stay out of the way).
 *
 * "First character" semantics is intentional over "block-exit" semantics:
 * it plays nicely with IME (composition disables intermediate transactions,
 * so PM only dispatches on `compositionend`), matches the ergonomic "stamp
 * as I start capturing" mental model, and removes the need for a blur
 * fallback — which would misfire when an IME popup steals focus before
 * `compositionstart` runs.
 *
 * A transaction meta flag (`pluginKey`) guards against re-entry so the stamp
 * transaction cannot re-trigger itself.
 */

/**
 * A snapshot of the paragraph currently containing the caret, or `null` when
 * the caret is not inside a paragraph (or the selection isn't a single point).
 * Encoding the "no paragraph tracked" case as `null` keeps `wasEmpty` from
 * carrying a meaningless value.
 */
type PluginState = {
  readonly paragraphStart: number
  readonly wasEmpty: boolean
} | null

/**
 * Injectable clock for tests. Production defaults to `() => new Date()`.
 */
export interface DailyNoteAutoTimestampPluginOptions {
  readonly getNow?: () => Date
}

const pluginKey = new PluginKey<PluginState>('dailyNoteAutoTimestamp')

/**
 * Builds the ProseMirror plugin. Exported as a factory so tests can inject a
 * clock; production callers mount it via the React extension component.
 */
export function dailyNoteAutoTimestampPlugin(
  options: DailyNoteAutoTimestampPluginOptions = {},
): Plugin<PluginState> {
  const getNow = options.getNow ?? ((): Date => new Date())

  return new Plugin<PluginState>({
    key: pluginKey,
    state: {
      init(_config, state) {
        return paragraphSnapshot(state)
      },
      apply(_tr, _prev, _oldState, newState) {
        return paragraphSnapshot(newState)
      },
    },
    appendTransaction(transactions, oldState, newState) {
      if (transactions.some((tr) => tr.getMeta(pluginKey) === true)) return null
      const previous = pluginKey.getState(oldState)
      const current = pluginKey.getState(newState)
      if (!previous || !current) return null
      const mappedPreviousStart = mapPositionThrough(transactions, previous.paragraphStart)
      if (mappedPreviousStart === null) return null
      if (mappedPreviousStart !== current.paragraphStart) return null
      if (!previous.wasEmpty || current.wasEmpty) return null
      return buildStampTransaction(newState, current.paragraphStart, getNow)
    },
  })
}

/**
 * Snapshot of the paragraph currently containing the caret — its content-start
 * position and whether it is empty. Returns `null` when the selection is a
 * range or the caret is not inside a paragraph.
 */
function paragraphSnapshot(state: EditorState): PluginState {
  const { $from, empty } = state.selection
  if (!empty) return null
  if ($from.parent.type.name !== 'paragraph') return null
  return {
    paragraphStart: $from.start($from.depth),
    wasEmpty: $from.parent.textContent.length === 0,
  }
}

/**
 * Map a position from an old state forward through a series of transactions.
 * Uses `assoc: -1` so a position at the very start of a paragraph's content
 * stays anchored to that paragraph even when a stamp is inserted at exactly
 * that position. Returns `null` if the position was removed.
 */
function mapPositionThrough(
  transactions: readonly Transaction[],
  position: number,
): number | null {
  let current = position
  for (const tr of transactions) {
    const mapped = tr.mapping.mapResult(current, -1)
    if (mapped.deleted) return null
    current = mapped.pos
  }
  return current
}

/**
 * Build a transaction that prefixes the paragraph starting at
 * `paragraphContentStart` with `` `HH:mm`  `` — but only when that paragraph
 * is a top-level bullet-list item and does not already begin with a backtick.
 * Returns `null` otherwise so the caller can skip dispatch.
 */
function buildStampTransaction(
  state: EditorState,
  paragraphContentStart: number,
  getNow: () => Date,
): Transaction | null {
  if (paragraphContentStart < 0 || paragraphContentStart > state.doc.content.size) return null
  const resolved = state.doc.resolve(paragraphContentStart)
  if (resolved.parent.type.name !== 'paragraph') return null
  if (resolved.depth !== 2) return null
  const list = resolved.node(resolved.depth - 1)
  if (list.type.name !== 'list') return null
  if (list.attrs['kind'] !== 'bullet') return null
  const text = resolved.parent.textContent
  if (text.length === 0) return null
  if (text.startsWith('`')) return null
  const stamp = `\`${format(getNow(), 'HH:mm')}\` `
  const tr = state.tr.insertText(stamp, paragraphContentStart)
  tr.setMeta(pluginKey, true)
  return tr
}
