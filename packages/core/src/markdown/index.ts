/**
 * `@reflect/core` markdown document model (Plan 03) — the one canonical
 * parse/extract/edit layer over `@lezer/markdown` + `yaml`, shared by the
 * indexer (Plan 04), editor (Plan 05), backlinks (Plan 07), and CLI (Plan 14).
 */
export {
  frontmatterSchema,
  gistFrontmatterSchema,
  isPinned,
  pinnedOrder,
  PARSED_NOTE_VERSION,
  type Frontmatter,
  type GistFrontmatter,
  type Span,
  type WikiLink,
  type MarkdownLink,
  type Heading,
  type AssetRef,
  type ParsedNote,
} from './model'
export {
  splitFrontmatter,
  parseFrontmatter,
  upsertFrontmatter,
  type FrontmatterSplit,
  type ParsedFrontmatter,
} from './frontmatter'
export { parseBody, reflectMarkdownParser, wikiLinkExtension } from './grammar'
export { parseNote, isTagName, hasAuthoredTitle } from './extract'
export {
  scanInlineWikiLinks,
  scanInlineImages,
  type InlineWikiLink,
  type InlineImage,
} from './scan'
export { appendBlock, appendUnderHeading, renameWikiLink } from './edit'
export {
  detectConflictMarkers,
  resolveConflictMarkers,
  type ConflictResolution,
} from './conflict-markers'
export { foldKey, foldTag } from './keys'
export { gistBodyHash, gistFilename } from './gist'
export { slugForTitle } from './slug'
export {
  normalizeWikiTarget,
  resolved,
  resolveWikiLink,
  resolveWikiLinkAsync,
  unresolved,
  type NormalizedTarget,
  type Resolution,
  type WikiLookup,
  type AsyncWikiLookup,
} from './resolve'
