/**
 * `@reflect/core` markdown document model (Plan 03) — the one canonical
 * parse/extract/edit layer over `@meowdown/markdown` + `yaml`, shared by the
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
  type TaskMarker,
  type ParsedNote,
} from './model'
export {
  splitFrontmatter,
  parseFrontmatter,
  upsertFrontmatter,
  type FrontmatterSplit,
  type ParsedFrontmatter,
} from './frontmatter'
export { parseBody } from './grammar'
export { parseNote, isTagName, hasAuthoredTitle } from './extract'
export {
  scanInlineWikiLinks,
  scanInlineImages,
  scanInlineSegments,
  type InlineWikiLink,
  type InlineImage,
  type InlineSegment,
} from './scan'
export {
  appendBlock,
  appendUnderHeading,
  appendTaskLine,
  appendTaskToContext,
  wikiLinkSafe,
  editTaskLine,
  removeTaskLine,
  setTaskDueDate,
  clearTaskDueDate,
  taskLineToBullet,
  toggleTaskMarker,
  TaskStaleError,
} from './edit'
export { retitleWikiLinks, type WikiLinkRetitleOptions } from './retitle'
export { displayNoteTitle, wikiLinkTargetForTitle } from './note-title'
export { parseTaskMarker } from './task-marker'
export {
  conflictMarkerBlockCount,
  conflictMarkerLabels,
  detectConflictMarkers,
  parseConflictMarkers,
  resolveConflictMarkers,
  type ConflictMarkerLabels,
  type ConflictResolution,
  type ConflictSegment,
  type ConflictSide,
} from './conflict-markers'
export {
  canonicalEmail,
  canonicalEmails,
  extractEmailFields,
  foldEmail,
} from './email-fields'
export { foldFallbackTitleKey, foldKey, foldTag } from './keys'
export { gistBodyHash, gistFilename } from './gist'
export { slugForTitle } from './slug'
export { subjectAliases } from './subject-aliases'
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
