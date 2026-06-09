import { GFM, parser as baseParser, type MarkdownConfig } from '@lezer/markdown'
import type { Tree } from '@lezer/common'

/**
 * The one canonical `@lezer/markdown` configuration (Plan 03): GFM plus a single
 * `[[wiki link]]` inline extension, written **once** and shared by the headless
 * indexer (here) and the editor (Plan 05 composes {@link wikiLinkExtension}).
 *
 * Frontmatter is stripped separately (see `frontmatter.ts`) — neither Lezer nor
 * the YAML loader parse the other's syntax — so this parser only sees the body.
 */

const OPEN_BRACKET = 91 // '['
const CLOSE_BRACKET = 93 // ']'
const NEWLINE = 10 // '\n'

/**
 * Inline parser for `[[target]]` / `[[target|alias]]`. Registered `before` the
 * standard `Link` parser so `[[` wins over `[`. Code spans/fences are consumed by
 * their own parsers first, so a `[[…]]` inside code is never seen here.
 */
export const wikiLinkExtension: MarkdownConfig = {
  defineNodes: [{ name: 'WikiLink' }],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN_BRACKET || cx.char(pos + 1) !== OPEN_BRACKET) {
          return -1
        }
        const contentStart = pos + 2
        for (let i = contentStart; i < cx.end; i++) {
          const ch = cx.char(i)
          if (ch === NEWLINE) {
            return -1 // wiki links don't span lines
          }
          if (ch === CLOSE_BRACKET && cx.char(i + 1) === CLOSE_BRACKET) {
            if (i === contentStart) {
              return -1 // empty `[[]]` isn't a link
            }
            return cx.addElement(cx.elt('WikiLink', pos, i + 2))
          }
        }
        return -1
      },
    },
  ],
}

/** GFM (tables, task lists, strikethrough, autolinks) + the wiki-link rule. */
export const reflectMarkdownParser = baseParser.configure([GFM, wikiLinkExtension])

/** Parse markdown **body** text (frontmatter already removed) into a Lezer tree. */
export function parseBody(body: string): Tree {
  return reflectMarkdownParser.parse(body)
}
