import { LEZER_NODE_IDS } from '@meowdown/markdown'

/**
 * Node-type predicates for trees produced by `parseBody` (meowdown's
 * `gfmParser` — Plan 03's one canonical grammar). Keyed by node **id** from
 * meowdown's `LEZER_NODE_IDS`, so a `@lezer/markdown` node rename is a compile
 * error here rather than a name test that silently stops matching. Node ids are
 * per-parser-configuration; `LEZER_NODE_IDS` is derived from `gfmParser` itself,
 * which is the only parser this package ever runs.
 */

/** Both heading spellings, mapped to the level they render at. */
const HEADING_LEVEL_BY_ID: ReadonlyMap<number, number> = new Map([
  [LEZER_NODE_IDS.ATXHeading1, 1],
  [LEZER_NODE_IDS.ATXHeading2, 2],
  [LEZER_NODE_IDS.ATXHeading3, 3],
  [LEZER_NODE_IDS.ATXHeading4, 4],
  [LEZER_NODE_IDS.ATXHeading5, 5],
  [LEZER_NODE_IDS.ATXHeading6, 6],
  // Setext has no level 3-6: `===` is an H1 and `---` an H2, nothing else.
  [LEZER_NODE_IDS.SetextHeading1, 1],
  [LEZER_NODE_IDS.SetextHeading2, 2],
])

/**
 * Structural minimum of a Lezer node, so these predicates accept both a
 * `SyntaxNode` and the `SyntaxNodeRef` a tree walk yields.
 */
interface TypedNode {
  type: { id: number }
}

/** The heading's level, or `null` when the node is not a heading. */
export function headingLevelOf(node: TypedNode): number | null {
  return HEADING_LEVEL_BY_ID.get(node.type.id) ?? null
}

/** Is this an unordered (`-`/`+`/`*`) list? */
export function isBulletList(node: TypedNode): boolean {
  return node.type.id === LEZER_NODE_IDS.BulletList
}

/** Is this a list item — the direct child of a bullet or ordered list? */
export function isListItem(node: TypedNode): boolean {
  return node.type.id === LEZER_NODE_IDS.ListItem
}

/** Is this the `-`/`+`/`*`/`1.` marker that opens a list item? */
export function isListMark(node: TypedNode): boolean {
  return node.type.id === LEZER_NODE_IDS.ListMark
}
