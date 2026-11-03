import type { LezerNodeName } from '@meowdown/markdown'
import { plainTextSpans } from '../markdown/extract.ts'
import { foldKey } from '../markdown/keys.ts'
import { isTitleHeading, type BlockContextSource } from './block-context.ts'
import { containsUnsegmentedScript } from './search-query.ts'

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

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * A test for whether a position of `body` falls between two characters as a
 * reader sees them, not inside one: a Thai vowel sign, a decomposed kana's
 * voiced mark, a Hangul final consonant or an emoji's skin tone belongs to
 * what comes before it, so a link must not start or end there. The segmenter
 * judges each position against the whole body (flags pair from the start of
 * their run) without listing every character.
 */
function characterBoundaries(body: string): (at: number) => boolean {
  let segments: Intl.Segments | undefined
  return (at) => {
    if (at === 0 || at === body.length) {
      return true
    }
    segments ??= graphemes.segment(body)
    // Asks where the character before `at` ends, not where the one at `at`
    // starts: macOS JavaScriptCore answers `containing(at)` with the previous
    // character when `at` starts an emoji or another astral character.
    const previous = segments.containing(at - 1)
    return previous !== undefined && previous.index + previous.segment.length === at
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Whether a word boundary is required beside `char` (a name's first or last).
 * Always, punctuation included (`C++` must not match inside `C++17`), except
 * in an unsegmented script, which doesn't separate words with spaces.
 */
function needsBoundary(char: string): boolean {
  return !containsUnsegmentedScript(char)
}

/**
 * Whether `char` (possibly absent at the text's edge) continues a word.
 */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR_RE.test(char)
}

/**
 * Body ranges of one note that matter to the matcher. Each list is in
 * document order and never overlaps itself, so it is sorted by end as well
 * as start and can be binary-searched.
 */
interface MentionRanges {
  /**
   * Ranges that can't hold a mention.
   */
  readonly excluded: Array<readonly [number, number]>
  /**
   * Syntax the app's plain text drops ({@link plainTextSpans}, the rules
   * behind note previews and these excerpts: marks, URLs, task boxes, …),
   * plus wiki-link brackets and an escape's backslash. A word boundary is
   * judged past them, so a mention is whole-word exactly when its excerpt
   * reads it so: `_Alice_` reads as "Alice", but `Acme*s*` as "Acmes",
   * `Acme\_v2` as "Acme_v2" and `[Bob](url)Alice` as "BobAlice". Never an
   * empty range: the walk past it must always move.
   */
  readonly hidden: Array<readonly [number, number]>
}

function mentionRanges(source: BlockContextSource): MentionRanges {
  const { body, tree, frontmatterTitled } = source
  const excluded: Array<readonly [number, number]> = []
  tree.iterate({
    enter: (node) => {
      if (NON_PROSE_NODES.has(node.name) || node.name.endsWith('Mark')) {
        excluded.push([node.from, node.to])
        return false
      }
      // The title heading is the note's name, not prose that refers to another note.
      if (node.name.endsWith('Heading1') && isTitleHeading(body, node.node, frontmatterTitled)) {
        excluded.push([node.from, node.to])
        return false
      }
      return true
    },
  })
  // `plainTextSpans` leaves wiki links whole and resolves escapes as text, so
  // their brackets and backslashes are added here.
  const dropped = plainTextSpans(tree).cuts.map(({ from, to }) => [from, to] as const)
  tree.iterate({
    enter: (node) => {
      if (node.name === 'WikilinkMark' || node.name === 'WikiEmbedMark') {
        dropped.push([node.from, node.to])
      } else if (node.name === 'Escape') {
        dropped.push([node.from, node.from + 1])
      }
    },
  })
  // Sorted and disjoint for the binary searches: a nested range (an escape
  // inside a URL) is already covered by the one around it.
  const hidden: Array<readonly [number, number]> = []
  for (const range of dropped.toSorted((left, right) => left[0] - right[0])) {
    if (range[1] > range[0] && range[0] >= (hidden.at(-1)?.[1] ?? 0)) {
      hidden.push(range)
    }
  }
  return { excluded, hidden }
}

/**
 * The index of the first of `ranges` (sorted, disjoint) that ends after `at`,
 * or `ranges.length` when none does.
 */
function firstEndingAfter(ranges: ReadonlyArray<readonly [number, number]>, at: number): number {
  let low = 0
  let high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const range = ranges[middle]
    if (range !== undefined && range[1] > at) {
      high = middle
    } else {
      low = middle + 1
    }
  }
  return low
}

function overlaps(ranges: ReadonlyArray<readonly [number, number]>, from: number, to: number) {
  const range = ranges[firstEndingAfter(ranges, from)]
  return range !== undefined && range[0] < to
}

function rangeEndingAt(ranges: ReadonlyArray<readonly [number, number]>, at: number) {
  const range = ranges[firstEndingAfter(ranges, at - 1)]
  return range?.[1] === at ? range : undefined
}

function rangeStartingAt(ranges: ReadonlyArray<readonly [number, number]>, at: number) {
  const range = ranges[firstEndingAfter(ranges, at)]
  return range?.[0] === at ? range : undefined
}

/**
 * The character a reader sees just before `at`, past any hidden syntax.
 */
function visibleCharBefore(
  body: string,
  hidden: ReadonlyArray<readonly [number, number]>,
  at: number,
): string | undefined {
  let position = at
  let range = rangeEndingAt(hidden, at)
  while (range !== undefined) {
    position = range[0]
    range = rangeEndingAt(hidden, position)
  }
  return [...body.slice(Math.max(0, position - 2), position)].at(-1)
}

/**
 * The character a reader sees just after `at`, past any hidden syntax.
 */
function visibleCharAfter(
  body: string,
  hidden: ReadonlyArray<readonly [number, number]>,
  at: number,
): string | undefined {
  let position = at
  let range = rangeStartingAt(hidden, at)
  while (range !== undefined) {
    position = range[1]
    range = rangeStartingAt(hidden, position)
  }
  return [...body.slice(position, position + 2)][0]
}

/**
 * Body-relative spans of one name: case-insensitive, whole-word (`Ann` must
 * not match inside `Annual`), and outside every excluded range. An edge in an
 * unsegmented script (Han, kana, …) needs no word boundary, since those
 * scripts don't separate words with spaces, but every edge falls between
 * characters. Word boundaries are judged by what a reader sees, past hidden
 * syntax (see {@link MentionRanges.hidden}), and checked here rather than
 * with a regex lookbehind, which WebKit before 16.4 can't parse.
 */
function nameSpans(
  body: string,
  name: string,
  { excluded, hidden }: MentionRanges,
  isCharacterBoundary: (at: number) => boolean,
): Array<readonly [number, number]> {
  const chars = [...name]
  const boundedBefore = needsBoundary(chars[0] ?? '')
  const boundedAfter = needsBoundary(chars.at(-1) ?? '')
  const key = foldKey(name)
  // Accents may be stored composed (NFC) or decomposed (NFD, common from
  // macOS), and link keys fold the two together: match either spelling.
  const spellings = new Set([name.normalize('NFC'), name.normalize('NFD')])
  const pattern = new RegExp([...spellings].map(escapeRegExp).join('|'), 'giu')
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
      (boundedBefore && isWordChar(visibleCharBefore(body, hidden, from))) ||
      (boundedAfter && isWordChar(visibleCharAfter(body, hidden, to))) ||
      overlaps(excluded, from, to) ||
      // Even where no word boundary is needed, a link never splits a character.
      // Last, as the costliest check.
      !isCharacterBoundary(from) ||
      !isCharacterBoundary(to)
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
 * Every unlinked, whole-word, case-insensitive occurrence of any of `names`
 * in the prepared note, in document order: the candidates of the
 * suggested-backlinks section, and the anchor its link write re-finds before
 * rewriting a mention into a wiki link. Where names overlap (`Ann` and
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
  const ranges = mentionRanges(source)
  const isCharacterBoundary = characterBoundaries(body)
  const spans = usable
    .flatMap((name) => nameSpans(body, name, ranges, isCharacterBoundary))
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
