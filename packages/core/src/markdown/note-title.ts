import { wikiLinkSafe } from './edit'
import { scanInlineSegments } from './scan'
import { subjectDisplayTitle } from './subject-aliases'

/**
 * Rich-title derivations: a note may legally embed markup in its title
 * (`Meeting with [[Ada Lovelace|Ada]]`). The raw title stays the note's
 * identity everywhere; these functions derive the reader-facing display
 * form, the flattened form, and the linkable wiki-link target form from it.
 * They are intentionally different renderings — see each doc comment.
 */

/**
 * The title as a reader sees it: a `//` subject reduced to its first segment
 * ({@link subjectDisplayTitle}), then its links flattened
 * ({@link flattenRichTitle}). The split runs on the raw title, so the shown
 * form is always the note's first derived alias, a linkable address.
 */
export function displayNoteTitle(title: string): string {
  return flattenRichTitle(subjectDisplayTitle(title))
}

/**
 * The title with its markup flattened: wiki links to their display text
 * (alias, else target) and markdown links to their text, through the canonical
 * grammar, so a `[[x]]` inside a code span stays literal, exactly as the
 * editor renders it. A `//` subject keeps every segment.
 */
export function flattenRichTitle(title: string): string {
  return scanInlineSegments(title)
    .map((segment) => {
      switch (segment.kind) {
        case 'text':
          return segment.text
        case 'wikiLink':
          return segment.alias ?? segment.target
        case 'link':
          return segment.text
      }
    })
    .join('')
}

/**
 * A complete `[[target]]` / `[[target|alias]]` embedded in a title. Mirrors the
 * grammar's inner-character rule (no `[`, `]`, or newline inside), but is
 * deliberately context-free: unlike {@link displayNoteTitle} it flattens links
 * even inside code spans, because the derived form must never carry `[[` — a
 * target that still contains wiki syntax could not be written into a link.
 */
const EMBEDDED_WIKI_LINK_RE = /\[\[([^[\]\n]*)\]\]/g

/** The title with embedded links flattened, or `null` when nothing was replaced. */
function renderEmbeddedWikiLinks(title: string): string | null {
  let replaced = false
  const rendered = title.replaceAll(EMBEDDED_WIKI_LINK_RE, (match, inner: string) => {
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (target === '') {
      return match // a whitespace-only target is not a link; keep it literal
    }
    replaced = true
    const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
    return alias || target
  })
  return replaced ? rendered : null
}

/**
 * The wiki-link target form of a title: embedded links flattened, then made
 * wiki-link safe. A title with no embedded links returns byte-for-byte, so an
 * ordinary title keeps its exact identity (`Project  Atlas` with two spaces
 * stays itself). A degenerate title whose derived form collapses to the empty
 * string falls back to the raw title rather than emitting an empty target.
 */
export function wikiLinkTargetForTitle(title: string): string {
  const rendered = renderEmbeddedWikiLinks(title)
  if (rendered === null) {
    return title
  }
  return wikiLinkSafe(rendered) || title
}
