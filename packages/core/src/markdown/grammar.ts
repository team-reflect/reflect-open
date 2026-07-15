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
const EXCLAMATION = 33 // '!'
const NEWLINE = 10 // '\n'

/**
 * Inline parser for Obsidian-style `![[target]]` embeds. Reflect's host
 * resolver decides whether the opaque target is a local attachment or a note;
 * the headless note index must still recognize the whole span so it never
 * mistakes the nested `[[...]]` for a backlink.
 */
export const wikiEmbedExtension: MarkdownConfig = {
  defineNodes: [{ name: 'WikiEmbed' }],
  parseInline: [
    {
      name: 'WikiEmbed',
      before: 'Link',
      parse(cx, next, pos) {
        if (
          next !== EXCLAMATION ||
          cx.char(pos + 1) !== OPEN_BRACKET ||
          cx.char(pos + 2) !== OPEN_BRACKET
        ) {
          return -1
        }
        const contentStart = pos + 3
        for (let index = contentStart; index < cx.end; index += 1) {
          const character = cx.char(index)
          if (character === NEWLINE) {
            return -1
          }
          if (character === CLOSE_BRACKET && cx.char(index + 1) === CLOSE_BRACKET) {
            return index === contentStart ? -1 : cx.addElement(cx.elt('WikiEmbed', pos, index + 2))
          }
        }
        return -1
      },
    },
  ],
}

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

/** GFM plus Reflect's wiki-link and wiki-embed rules. */
export const reflectMarkdownParser = baseParser.configure([
  GFM,
  wikiEmbedExtension,
  wikiLinkExtension,
])

/** Parse markdown **body** text (frontmatter already removed) into a Lezer tree. */
export function parseBody(body: string): Tree {
  return reflectMarkdownParser.parse(body)
}
