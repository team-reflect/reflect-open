import { type MarkMode } from '@meowdown/core'
import { type EditorMarkdownSyntax } from '@reflect/core'

/**
 * Translate Reflect's implementation-neutral `editorMarkdownSyntax` setting to
 * meowdown's editor "mark mode". The setting name outlives any one editor
 * library, so the mapping lives here at the boundary: `hide`/`show` pass
 * through, and `hybrid` (reveal syntax only around the caret) is meowdown's
 * `focus` mode.
 */
const MARK_MODE_BY_SYNTAX: Record<EditorMarkdownSyntax, MarkMode> = {
  hide: 'hide',
  show: 'show',
  hybrid: 'focus',
}

export function markModeFromSyntax(syntax: EditorMarkdownSyntax): MarkMode {
  return MARK_MODE_BY_SYNTAX[syntax]
}
