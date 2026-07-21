/**
 * The grammar's wiki nodes: `Wikilink` (`[[target]]`) and `WikiEmbed`
 * (`![[target]]`). An embed is a `!` plus a wikilink shape, and every walker
 * that projects links treats it as one — {@link wikiBracketStart} maps a node
 * to where its `[[` begins so both shapes share the same slicing arithmetic.
 */

import type { LezerNodeName } from "@meowdown/markdown";

export function isWikiNodeName(name: string): boolean {
  return name === ('Wikilink' satisfies LezerNodeName) || name === ('WikiEmbed' satisfies LezerNodeName)
}

/** Offset of the node's `[[`: a `WikiEmbed` skips its leading `!`. */
export function wikiBracketStart(node: { name: string; from: number }): number {
  return node.name === ('WikiEmbed' satisfies LezerNodeName) ? node.from + 1 : node.from
}
