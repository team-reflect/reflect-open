import { parseNote } from './extract'
import { foldKey } from './keys'

/**
 * The source-level half of a retitle (Plan 07b): given one note that links to a
 * renamed subject, rewrite the links that addressed it. Pure and position-based
 * like the rest of `edit.ts` — deciding *which* targets belong to the subject
 * needs the index, and lives in `indexing/rename.ts`.
 */

interface Splice {
  from: number
  to: number
  text: string
}

/** Apply non-overlapping splices, right-to-left so earlier offsets stay valid. */
function applySplices(source: string, splices: Splice[]): string {
  let result = source
  for (const splice of [...splices].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, splice.from) + splice.text + result.slice(splice.to)
  }
  return result
}

/** Which links one source's retitle touches, and how. The caller decides each. */
export interface WikiLinkRetitleOptions {
  /**
   * Repoint every link whose folded target equals `fromKey`, or `null` to leave
   * every target where it is (the old title belongs to another note now, or the
   * new one is not an address the subject has been proven to own).
   */
  repoint: { fromKey: string; to: string } | null
  /**
   * Replace a pipe display that still *exactly* mirrors `from`, or `null` to
   * leave every display alone. Exactness is the whole policy: a label the user
   * wrote (`[[stable-address|Mum]]`) is not derived text. Proving `to` is
   * writable belongs to the caller (`isWikiLinkSafeText`).
   */
  display: { from: string; to: string } | null
  /**
   * Folded target keys already proven to address the subject. Only these links
   * sync their display, so a stable target another note has since claimed keeps
   * its label.
   */
  subjectTargetKeys: ReadonlySet<string>
}

/**
 * Rewrite one source's wiki links for a subject's retitle: repoint the links
 * that addressed it by its old title, and refresh the pipe displays that still
 * mirror that title. Byte-preserving: a link whose target and display both
 * survive is not re-serialized, and the surviving half of a rewritten link
 * keeps its original bytes, escapes and padding included.
 */
export function retitleWikiLinks(source: string, options: WikiLinkRetitleOptions): string {
  const { repoint, display, subjectTargetKeys } = options
  // `[[…]]` has no escaping, so a target can't contain the bracket/pipe/newline
  // characters that delimit the syntax — writing one would corrupt the link.
  if (repoint !== null && /[[\]|\r\n]/.test(repoint.to)) {
    throw new Error(`invalid wiki-link target (cannot contain [ ] | or a newline): ${repoint.to}`)
  }
  const splices: Splice[] = []
  for (const link of parseNote({ path: '', source }).wikiLinks) {
    // The parser's own span math (`readWikiLink`): `[[` + inner + `]]`.
    const inner = source.slice(link.from + 2, link.to - 2)
    const pipe = inner.indexOf('|')
    const targetRaw = pipe === -1 ? inner : inner.slice(0, pipe)
    const displayRaw = pipe === -1 ? null : inner.slice(pipe + 1)

    const targetKey = foldKey(link.target)
    const nextTarget = repoint !== null && targetKey === repoint.fromKey ? repoint.to : targetRaw
    // A bare `[[target]]` has no display to mirror the old title, so it never
    // gains one: `link.alias` is undefined and can't equal `display.from`.
    const nextDisplay =
      display !== null && subjectTargetKeys.has(targetKey) && link.alias === display.from
        ? display.to
        : displayRaw
    if (nextTarget === targetRaw && nextDisplay === displayRaw) {
      continue
    }
    splices.push({
      from: link.from,
      to: link.to,
      text: nextDisplay === null ? `[[${nextTarget}]]` : `[[${nextTarget}|${nextDisplay}]]`,
    })
  }
  return applySplices(source, splices)
}
