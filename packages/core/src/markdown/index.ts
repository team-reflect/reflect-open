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
} from './model.ts'
export {
  splitFrontmatter,
  parseFrontmatter,
  upsertFrontmatter,
  type FrontmatterSplit,
  type ParsedFrontmatter,
} from './frontmatter.ts'
export { parseBody } from './grammar.ts'
export { parseNote, isTagName, hasAuthoredTitle } from './extract.ts'
export {
  scanInlineWikiLinks,
  scanInlineImages,
  scanInlineSegments,
  type InlineWikiLink,
  type InlineImage,
  type InlineSegment,
} from './scan.ts'
export {
  appendBlock,
  appendListItem,
  type ListItemKind,
  appendTaskUnderHeading,
  type TaskInsertion,
  appendTaskToContext,
  wikiLinkSafe,
  editTaskLine,
  removeTaskLine,
  setTaskDueDate,
  clearTaskDueDate,
  taskLineToBullet,
  toggleTaskMarker,
  TaskStaleError,
} from './edit.ts'
export { retitleWikiLinks, type WikiLinkRetitleOptions } from './retitle.ts'
export { displayNoteTitle, wikiLinkTargetForTitle } from './note-title.ts'
export { parseTaskMarker } from './task-marker.ts'
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
} from './conflict-markers.ts'
export { canonicalEmail, canonicalEmails, extractEmailFields, foldEmail } from './email-fields.ts'
export { foldFallbackTitleKey, foldKey, foldTag } from './keys.ts'
export { documentLineEnding } from './line-endings.ts'
export { gistBodyHash, gistFilename } from './gist.ts'
export { slugForTitle } from './slug.ts'
export { subjectAliases } from './subject-aliases.ts'
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
} from './resolve.ts'
