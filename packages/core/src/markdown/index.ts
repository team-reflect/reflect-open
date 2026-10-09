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
export { appendBlock, wikiLinkSafe, setTaskDueDate, clearTaskDueDate } from './edit.ts'
export { retitleWikiLinks, type WikiLinkRetitleOptions } from './retitle.ts'
export { displayNoteTitle, wikiLinkTargetForTitle } from './note-title.ts'
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
export { gistBodyHash, gistFilename } from './gist.ts'
export { slugForTitle } from './slug.ts'
export { subjectAliases } from './subject-aliases.ts'
export {
  readNoteAliases,
  rejectAlias,
  withAlias,
  withoutAlias,
  type AliasRejection,
  type NoteAliases,
} from './note-aliases.ts'
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
export { renderInlineText } from './inline-text.ts'
export { compareTaskPaths, decodeTaskPath, encodeTaskPath, isSameTaskPath } from './task-path.ts'
export {
  appendListItem,
  linkSectionHeading,
  type ListItemInsert,
  type ListItemKind,
  type SectionTarget,
  applyTaskEdits,
  findTaskMove,
  getFirstParagraphMarkdown,
  getRoundTasks,
  getTaskDueDate,
  isRoundTask,
  NoteNotSerializableError,
  projectTasks,
  renderTaskSnapshot,
  TaskStaleError,
  type InsertPosition,
  type ParsedTask,
  type TaskEdit,
  type TaskEditInsert,
  type TaskEditItem,
  type TaskEditResult,
  type TaskMove,
  type TaskEntry,
  type TaskLocator,
  type TaskRow,
  type TaskSnapshot,
} from './task-ast.ts'
