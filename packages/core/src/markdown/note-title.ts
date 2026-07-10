import { wikiLinkSafe } from './edit'
import { scanInlineSegments } from './scan'

function renderEmbeddedWikiLinks(title: string): string | null {
  let rendered = ''
  let cursor = 0
  let replaced = false
  while (cursor < title.length) {
    const open = title.indexOf('[[', cursor)
    if (open === -1) {
      break
    }
    const close = title.indexOf(']]', open + 2)
    if (close === -1) {
      break
    }
    const inner = title.slice(open + 2, close)
    if (inner.includes('\n') || inner.includes('\r')) {
      rendered += title.slice(cursor, open + 2)
      cursor = open + 2
      continue
    }
    const pipe = inner.indexOf('|')
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
    if (target === '') {
      rendered += title.slice(cursor, open + 2)
      cursor = open + 2
      continue
    }
    const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim()
    rendered += title.slice(cursor, open) + (alias || target)
    cursor = close + 2
    replaced = true
  }
  if (!replaced) {
    return null
  }
  return rendered + title.slice(cursor)
}

/**
 * Render a note title the way the editor presents its inline links: wiki links
 * use their alias (or target), and Markdown links use their visible text.
 * Other inline Markdown stays source-shaped so a plain title is unchanged.
 */
export function displayNoteTitle(title: string): string {
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
 * The valid wiki-link target for a title containing embedded `[[...]]` source.
 * Nested wiki links have no escaping, so each embedded form is replaced by its
 * alias (or target) and remaining delimiters are sanitized. Titles without an
 * embedded form are returned byte-for-byte, preserving their existing identity.
 */
export function wikiLinkTargetForTitle(title: string): string {
  const rendered = renderEmbeddedWikiLinks(title)
  return rendered === null ? title : wikiLinkSafe(rendered)
}
