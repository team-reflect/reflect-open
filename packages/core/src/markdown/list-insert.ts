import {
  isMarkdownAstEqual,
  parseMarkdownAst,
  serializeMarkdownAst,
  walkMarkdownAst,
  type MarkdownBlock,
  type MarkdownDocument,
  type MarkdownListItem,
} from '@meowdown/markdown'
import { appendBlock } from './append-section.ts'
import { splitFrontmatter } from './frontmatter.ts'
import { renderInlineText } from './inline-text.ts'
import { NoteEditError } from '../tasks/task-errors.ts'
import { foldKey } from './keys.ts'
import { scanInlineWikiLinks } from './scan.ts'
import { getFirstParagraphMarkdown, isBlockParent, type BlockParent } from './task-project.ts'

/**
 * A slot for a new item: right after a block, or at the end of a container.
 */
export type SlotTarget =
  | { kind: 'after'; anchor: MarkdownBlock }
  | { kind: 'end'; container: MarkdownDocument | MarkdownListItem }
  /**
   * A new section after the document's last content, holding the item.
   */
  | { kind: 'newSection'; heading: string }

/**
 * The note body as a tree the serializer can write back faithfully, or a
 * `notWritable` {@link NoteEditError}. An empty body has no blocks (the parser
 * gives it one empty paragraph).
 */
export function parseEditable(source: string): { document: MarkdownDocument; bodyOffset: number } {
  const { body, bodyOffset } = splitFrontmatter(source)
  const document = parseMarkdownAst(body)
  if (body === '') {
    document.children = []
  }
  if (
    document.children.length > 0 &&
    !isMarkdownAstEqual(parseMarkdownAst(serializeMarkdownAst(document)), document)
  ) {
    throw new NoteEditError(
      'notWritable',
      'This note cannot be rewritten faithfully. Edit it in the note itself.',
    )
  }
  return { document, bodyOffset }
}

export function serializeBody(document: MarkdownDocument): string {
  return document.children.length === 0 ? '' : serializeMarkdownAst(document)
}

/**
 * The character an item is written with; meowdown leaves it unset on a folded
 * bullet, which it writes as `+`.
 */
function markerOf(item: MarkdownListItem): string | undefined {
  return item.marker ?? (item.kind === 'bullet' && item.collapsed ? '+' : undefined)
}

/**
 * The index of the last item of the list that starts at `children[start]`: same
 * marker, nothing else between.
 */
export function endOfListRun(children: readonly MarkdownBlock[], start: number): number {
  const first = children[start]
  const marker = first?.type === 'listItem' ? markerOf(first) : undefined
  let end = start
  for (let i = start + 1; i < children.length; i++) {
    const block = children[i]
    if (block?.type !== 'listItem' || markerOf(block) !== marker) {
      break
    }
    end = i
  }
  return end
}

/**
 * How an appended line renders: a plain bullet, the square GFM checkbox, or
 * Reflect's round `+ [ ]` task.
 */
export type ListItemKind = 'bullet' | 'checkbox' | 'task'

type BulletMarker = '-' | '*' | '+'

/**
 * Where an automatic entry lands: the first list it can join under a
 * top-level H1 or H2 that names the section, created after the note's last
 * content when missing.
 */
export interface SectionTarget {
  /**
   * The titles the heading may read as; the first one names a new heading.
   */
  readonly titles: readonly string[]
  /**
   * Write the heading as `## [[Title]]`, upgrading a plain `## Title` in place.
   */
  readonly linked: boolean
}

/**
 * The section the Tasks view and task captures file new tasks in.
 */
export const TASKS_SECTION: SectionTarget = { titles: ['Tasks'], linked: false }

/**
 * Whether a heading's or bullet's inline Markdown names one of `titles`: by
 * the text it renders as, or by the target of a wiki link in it
 * (`## [[Links|Saved links]]` is the Links section).
 */
function inlineNames(value: string, titles: readonly string[]): boolean {
  const keys = titles.map((title) => foldKey(title))
  return (
    keys.includes(foldKey(renderInlineText(value))) ||
    scanInlineWikiLinks(value).some((link) => keys.includes(foldKey(link.target)))
  )
}

/**
 * The index of the first top-level H1 or H2 that names the section.
 */
function findSectionHeading(
  children: readonly MarkdownBlock[],
  section: SectionTarget,
): number | undefined {
  const index = children.findIndex((block) => {
    return block.type === 'heading' && block.level <= 2 && inlineNames(block.value, section.titles)
  })
  return index === -1 ? undefined : index
}

/**
 * The marker a `kind` item takes to join the list `item` starts, or undefined
 * when it must not: a bullet joins any bullet list; a checkbox joins `-` and
 * `*` but never `+`, because `+ [ ]` IS a task; a task joins only `+`.
 */
function joinMarker(kind: ListItemKind, item: MarkdownListItem): BulletMarker | undefined {
  const marker = markerOf(item)
  if (marker !== '-' && marker !== '*' && marker !== '+') {
    return undefined
  }
  if (kind === 'task') {
    return marker === '+' ? '+' : undefined
  }
  if (kind === 'checkbox') {
    return marker === '+' ? undefined : marker
  }
  return marker
}

/**
 * The index of the first list between the heading at `heading` and the next
 * heading of any level that a `kind` item can join, or undefined when the
 * section has none.
 */
function findSectionList(
  children: readonly MarkdownBlock[],
  heading: number,
  kind: ListItemKind,
): number | undefined {
  for (let i = heading + 1; i < children.length; i++) {
    const block = children[i]
    if (block?.type === 'heading') {
      return undefined
    }
    if (block?.type === 'listItem' && joinMarker(kind, block) !== undefined) {
      return i
    }
  }
  return undefined
}

/**
 * After the last child of the first top-level plain bullet whose own text
 * names `parent`, joining its list. A missing parent is added as `- parent`
 * after the note's last content.
 */
function parentSlot(document: MarkdownDocument, parent: string): SlotTarget {
  const titles = [
    renderInlineText(parent),
    ...scanInlineWikiLinks(parent).map((link) => link.target),
  ]
  let container = document.children.find((block): block is MarkdownListItem => {
    return (
      block.type === 'listItem' &&
      block.kind === 'bullet' &&
      inlineNames(getFirstParagraphMarkdown(block), titles)
    )
  })
  if (container === undefined) {
    // Always `-`: joining a folded `+` list would fold the new parent and hide the entry.
    container = createListItem('bullet', '-', parent)
    insertItem(document, bodyEndSlot(document), container)
  }
  const last = container.children.at(-1)
  return last?.type === 'listItem' ? { kind: 'after', anchor: last } : { kind: 'end', container }
}

/**
 * After the section's list, else right under its heading, else in a new section
 * after the last content.
 */
export function sectionSlot(
  document: MarkdownDocument,
  section: SectionTarget,
  kind: ListItemKind,
): SlotTarget {
  const { children } = document
  const heading = findSectionHeading(children, section)
  if (heading === undefined) {
    const title = section.titles[0] ?? ''
    return { kind: 'newSection', heading: section.linked ? `[[${title}]]` : title }
  }
  const list = findSectionList(children, heading, kind)
  return {
    kind: 'after',
    anchor: children[list === undefined ? heading : endOfListRun(children, list)]!,
  }
}

/**
 * The index after the last block that is not a blank line: `children.length`
 * without the trailing blank lines.
 */
function contentEnd(children: readonly MarkdownBlock[]): number {
  for (let i = children.length - 1; i >= 0; i--) {
    const block = children[i]
    if (block !== undefined && !(block.type === 'paragraph' && block.value === '')) {
      return i + 1
    }
  }
  return 0
}

/**
 * After the last block that is not a blank line, so trailing blank lines stay
 * below the entry.
 */
function bodyEndSlot(document: MarkdownDocument): SlotTarget {
  const anchor = document.children[contentEnd(document.children) - 1]
  return anchor === undefined ? { kind: 'end', container: document } : { kind: 'after', anchor }
}

/**
 * The marker a new item is written with: the list it joins, else the kind's
 * own.
 */
function markerFor(kind: ListItemKind, slot: SlotTarget): BulletMarker {
  const joined =
    slot.kind === 'after' && slot.anchor.type === 'listItem'
      ? joinMarker(kind, slot.anchor)
      : undefined
  return joined ?? (kind === 'task' ? '+' : '-')
}

export function createListItem(
  kind: ListItemKind,
  marker: BulletMarker,
  markdown: string,
): MarkdownListItem {
  const item: MarkdownListItem = {
    type: 'listItem',
    kind: kind === 'bullet' ? 'bullet' : 'task',
    checked: false,
    collapsed: false,
    children: [{ type: 'paragraph', value: markdown }],
  }
  // meowdown writes a folded bullet as `+` and keeps its marker unset.
  if (kind === 'bullet' && marker === '+') {
    item.collapsed = true
  } else {
    item.marker = marker
  }
  return item
}

/**
 * One list item to file: its kind, its Markdown, and where it belongs (the end
 * of the note when neither is set).
 */
export interface ListItemInsert {
  readonly kind: ListItemKind
  readonly markdown: string
  readonly section?: SectionTarget | undefined
  /**
   * The top-level bullet the item nests under as its last child, created
   * after the note's last content when missing. Takes precedence over `section`.
   */
  readonly parent?: string | undefined
}

/**
 * Append one list item to a note the way captures, meetings, and audio memos
 * file their entries: into the section's first joinable list, directly under
 * its heading when it has none, or in a new section after the note's last
 * content; without a section, after the note's last content too. With a
 * parent, as the last child of that top-level bullet instead. Trailing
 * blank lines stay below the entry. The serializer decides the other blank
 * lines and keeps a list of another marker separate.
 */
export function appendListItem(source: string, insert: ListItemInsert): string {
  let editable: ReturnType<typeof parseEditable>
  try {
    editable = parseEditable(source)
  } catch (cause) {
    if (!(cause instanceof NoteEditError && cause.kind === 'notWritable')) {
      throw cause
    }
    // A note the serializer would alter still takes the entry: as a fresh
    // list at the end, the way captures were always filed. Nothing is lost,
    // and no capture, meeting, or memo stalls on one unusual note.
    const marker = insert.kind === 'task' ? '+' : '-'
    const payload =
      insert.kind === 'bullet' ? insert.markdown.trim() : `[ ] ${insert.markdown.trim()}`
    return appendBlock(source, `${marker} ${payload}`)
  }
  const { document, bodyOffset } = editable
  const parent = insert.parent?.trim()
  if (!parent && insert.section?.linked) {
    linkHeading(document, insert.section)
  }
  const slot = parent
    ? parentSlot(document, parent)
    : insert.section === undefined
      ? bodyEndSlot(document)
      : sectionSlot(document, insert.section, insert.kind)
  const marker = markerFor(insert.kind, slot)
  insertItem(document, slot, createListItem(insert.kind, marker, insert.markdown.trim()))
  return source.slice(0, bodyOffset) + serializeBody(document)
}

/**
 * Write the section's heading as `## [[Title]]` when the note has it as a
 * plain `## Title`; a missing or already linked section is left alone.
 */
export function linkSectionHeading(source: string, section: SectionTarget): string {
  const { document, bodyOffset } = parseEditable(source)
  return linkHeading(document, section)
    ? source.slice(0, bodyOffset) + serializeBody(document)
    : source
}

/**
 * Rewrite a plain section heading as `[[Title]]`; false when there is none to
 * rewrite.
 */
function linkHeading(document: MarkdownDocument, section: SectionTarget): boolean {
  const index = findSectionHeading(document.children, section)
  const heading = index === undefined ? undefined : document.children[index]
  if (heading?.type !== 'heading' || scanInlineWikiLinks(heading.value).length > 0) {
    return false
  }
  heading.value = `[[${section.titles[0] ?? ''}]]`
  return true
}

/**
 * Parents and indexes are looked up when the edit is applied, not when it was
 * resolved: an earlier edit in the batch may have shifted the siblings or
 * lifted the node out of a removed parent.
 */
export function insertItem(
  document: MarkdownDocument,
  slot: SlotTarget,
  item: MarkdownListItem,
): MarkdownListItem {
  if (slot.kind === 'after') {
    const { parent, index } = requireAttached(document, slot.anchor)
    parent.children.splice(index + 1, 0, item)
  } else if (slot.kind === 'newSection') {
    // Trailing blank lines stay below the new section.
    const { children } = document
    children.splice(
      contentEnd(children),
      0,
      { type: 'heading', level: 2, value: slot.heading },
      item,
    )
  } else {
    if (slot.container.type === 'listItem') {
      requireAttached(document, slot.container)
    }
    slot.container.children.push(item)
  }
  return item
}

interface Attachment {
  parent: BlockParent
  index: number
}

/**
 * Where `target` currently sits in the tree, or a stale error once an earlier
 * edit detached it.
 */
export function requireAttached(document: MarkdownDocument, target: MarkdownBlock): Attachment {
  for (const { node, parent } of walkMarkdownAst(document)) {
    if (node === target && parent !== undefined && isBlockParent(parent)) {
      return { parent, index: parent.children.indexOf(target) }
    }
  }
  throw new NoteEditError('stale', 'the task was removed earlier in this batch')
}
