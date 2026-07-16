import { gfmParser, type Tree } from '@meowdown/markdown'

/**
 * The one canonical grammar (Plan 03): meowdown's `gfmParser` — the editor's
 * own parser (GFM plus `[[wiki links]]`, `![[embeds]]`, hashtags, highlights,
 * math, and bare autolinks) — so the indexer and the editor can never disagree
 * on what a piece of markdown means.
 *
 * Frontmatter is stripped separately (see `frontmatter.ts`) — neither Lezer nor
 * the YAML loader parse the other's syntax — so this parser only sees the body.
 */

/** Parse markdown **body** text (frontmatter already removed) into a Lezer tree. */
export function parseBody(body: string): Tree {
  return gfmParser.parse(body)
}
