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
  scanInlineSegments,
  type InlineWikiLink,
  type InlineSegment,
} from './scan.ts'
export { wikiLinkSafe, setTaskDueDate, clearTaskDueDate } from './edit.ts'
export { appendBlock } from './append-section.ts'
export { retitleWikiLinks, type WikiLinkRetitleOptions } from './retitle.ts'
export { displayNoteTitle, wikiLinkTargetForTitle } from './note-title.ts'
export { canonicalEmail, canonicalEmails, extractEmailFields } from './email-fields.ts'
export { foldFallbackTitleKey, foldKey, foldTag } from './keys.ts'
export { gistBodyHash, gistFilename } from './gist.ts'
export { slugForTitle } from './slug.ts'
export { subjectAliases } from './subject-aliases.ts'
export {
  normalizeWikiTarget,
  resolved,
  unresolved,
  type NormalizedTarget,
  type Resolution,
} from './resolve.ts'
export { renderInlineText } from './inline-text.ts'
export { compareTaskPaths, encodeTaskPath, isSameTaskPath } from './task-path.ts'
export {
  appendListItem,
  linkSectionHeading,
  type ListItemInsert,
  type ListItemKind,
  type SectionTarget,
} from './list-insert.ts'
export {
  applyTaskEdits,
  type InsertPosition,
  type TaskEdit,
  type TaskEditInsert,
  type TaskEditItem,
  type TaskEditResult,
  type TaskMove,
} from './task-edit.ts'
export {
  getFirstParagraphMarkdown,
  getRoundTasks,
  getTaskDueDate,
  isRoundTask,
  projectTasks,
  renderTaskSnapshot,
  type TaskEntry,
  type TaskRow,
} from './task-project.ts'
export {
  hasSameTaskContent,
  toTaskLocator,
  type ParsedTask,
  type TaskLocator,
  type TaskSnapshot,
} from './task-model.ts'
