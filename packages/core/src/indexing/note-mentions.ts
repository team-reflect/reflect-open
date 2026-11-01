import type { LezerNodeName } from '@meowdown/markdown'
import { wikiNoteReference } from '../graph/note-reference.ts'
import { readWikiLink } from '../markdown/extract.ts'
import { foldKey } from '../markdown/keys.ts'
import { isWikiNodeName, wikiBracketStart } from '../markdown/wiki-nodes.ts'
import { isTitleHeading, type BlockContextSource } from './block-context.ts'
import { containsUnsegmentedScript } from './search-query.ts'

/**
 * Plain-text mentions of a note's names in another note's Markdown: the
 * candidates of the suggested-backlinks section, and the anchor its link
 * write re-finds before rewriting a mention into a wiki link.
 */

/**
 * One plain-text occurrence of a note name, in whole-file offsets.
 */
export interface NoteMention {
  readonly from: number
  readonly to: number
  /**
   * The occurrence exactly as written in the source.
   */
  readonly text: string
}

/**
 * Nodes whose text is not prose: code, raw HTML, math, existing links,
 * embeds, URLs, and hashtags. A name inside one is never a mention — linking
 * it would break the construct or change what it means.
 */
const NON_PROSE_NODES = new Set<string>([
  'FencedCode',
  'CodeBlock',
  'InlineCode',
  'HTMLBlock',
  'HTMLTag',
  'CommentBlock',
  'Comment',
  'ProcessingInstructionBlock',
  'ProcessingInstruction',
  'LinkReference',
  'Link',
  'Image',
  'URL',
  'Autolink',
  'Hashtag',
  'Wikilink',
  'WikiEmbed',
  'InlineMath',
  'BlockMath',
  'Escape',
  'Entity',
] satisfies LezerNodeName[])

/**
 * A character that continues a word. Combining marks count: Indic scripts
 * write vowels as marks (`रामायण` is `राम` + `ा` + …), so a name followed by
 * one is part of a longer word, not a whole-word mention.
 */
const WORD_CHAR_RE = /[\p{L}\p{M}\p{N}_]/u

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Whether a word boundary is required beside `char` (a name's first or last).
 */
function needsBoundary(char: string): boolean {
  return WORD_CHAR_RE.test(char) && !containsUnsegmentedScript(char)
}

/**
 * Whether `char` (possibly absent at the text's edge) continues a word.
 */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR_RE.test(char)
}

/**
 * Body ranges that can't hold a mention, in document order.
 */
function excludedRanges(source: BlockContextSource): Array<readonly [number, number]> {
  const { body, tree, frontmatterTitled } = source
  const ranges: Array<readonly [number, number]> = []
  tree.iterate({
    enter: (node) => {
      if (NON_PROSE_NODES.has(node.name) || node.name.endsWith('Mark')) {
        ranges.push([node.from, node.to])
        return false
      }
      // The title heading is the note's name, not prose that refers to another note.
      if (node.name.endsWith('Heading1') && isTitleHeading(body, node.node, frontmatterTitled)) {
        ranges.push([node.from, node.to])
        return false
      }
      return true
    },
  })
  return ranges
}

function overlaps(ranges: ReadonlyArray<readonly [number, number]>, from: number, to: number) {
  return ranges.some(([start, end]) => from < end && to > start)
}

/**
 * Body-relative spans of one name: case-insensitive, whole-word (`Ann` must
 * not match inside `Annual`), and outside every excluded range. An edge in an
 * unsegmented script (Han, kana, …) needs no boundary, since those scripts
 * don't separate words with spaces. A neighbour that is Markdown syntax (the
 * `_` of `_Alice_`) is not part of a word. Boundaries are checked here rather
 * than with a regex lookbehind, which WebKit before 16.4 can't parse.
 */
function nameSpans(
  body: string,
  name: string,
  excluded: ReadonlyArray<readonly [number, number]>,
): Array<readonly [number, number]> {
  const chars = [...name]
  const boundedBefore = needsBoundary(chars[0] ?? '')
  const boundedAfter = needsBoundary(chars.at(-1) ?? '')
  const key = foldKey(name)
  const pattern = new RegExp(escapeRegExp(name), 'giu')
  const spans: Array<readonly [number, number]> = []
  for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) {
    const from = match.index
    const to = from + match[0].length
    const before = [...body.slice(Math.max(0, from - 2), from)].at(-1)
    const after = [...body.slice(to, to + 2)][0]
    if (
      // Regex case-insensitivity folds a few letters (`ſ`, `ϐ`) that link keys
      // don't, so `[[Gauſs]]` would not open `Gauss`: the written text must
      // fold to the name's own key.
      foldKey(match[0]) !== key ||
      // Not a mention in prose: text glued to `!` (an embed once linked), to a
      // backslash (a path segment or an escape), or inside plain brackets.
      before === '!' ||
      before === '\\' ||
      before === '[' ||
      after === ']' ||
      (boundedBefore && isWordChar(before) && !overlaps(excluded, from - 1, from)) ||
      (boundedAfter && isWordChar(after) && !overlaps(excluded, to, to + 1)) ||
      overlaps(excluded, from, to)
    ) {
      // Retry from the next character: a rejected match must not hide one
      // that starts inside it. A whole code point, not one UTF-16 unit: under
      // the `u` flag a lastIndex inside a surrogate pair (an emoji, a rare Han
      // character) is moved back to its start, re-matching the same span forever.
      pattern.lastIndex = from + ((body.codePointAt(from) ?? 0) > 0xffff ? 2 : 1)
      continue
    }
    spans.push([from, to])
  }
  return spans
}

/**
 * Whether the prepared note already has a wiki link (or embed) whose target
 * reads as one of `names`: the note links to the named note in its current
 * text, even if the index has not caught up with that write yet.
 */
export function linksToAnyName(source: BlockContextSource, names: readonly string[]): boolean {
  const { body, tree } = source
  const keys = new Set(names.map(foldKey))
  let found = false
  tree.iterate({
    enter: (node) => {
      if (found) {
        return false
      }
      if (!isWikiNodeName(node.name)) {
        return true
      }
      const { target } = readWikiLink(body, wikiBracketStart(node), node.to, 0)
      const reference = wikiNoteReference(target)
      if (
        (reference?.kind === 'key' || reference?.kind === 'pathOrKey') &&
        keys.has(reference.key)
      ) {
        found = true
      }
      return false
    },
  })
  return found
}

/**
 * Every unlinked, whole-word, case-insensitive occurrence of any of `names`
 * in the prepared note, in document order. Where names overlap (`Ann` and
 * `Ann Lee`), the earliest wins, then the longest. Frontmatter is never
 * searched; see {@link NON_PROSE_NODES} for what else is skipped.
 */
export function findNoteMentions(
  source: BlockContextSource,
  names: readonly string[],
): NoteMention[] {
  const { body, bodyOffset } = source
  const usable = names.filter((name) => name.trim() !== '')
  if (usable.length === 0) {
    return []
  }
  const excluded = excludedRanges(source)
  const spans = usable
    .flatMap((name) => nameSpans(body, name, excluded))
    .toSorted((left, right) => left[0] - right[0] || right[1] - left[1])
  const mentions: NoteMention[] = []
  let taken = 0
  for (const [from, to] of spans) {
    if (from < taken) {
      continue
    }
    taken = to
    mentions.push({
      from: from + bodyOffset,
      to: to + bodyOffset,
      text: body.slice(from, to),
    })
  }
  return mentions
}
