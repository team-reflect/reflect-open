import type { SyntaxNode } from '@lezer/common'
import { parseBody } from '../markdown/grammar'
import { parseTaskMarker } from '../markdown/task-marker'

/**
 * Task checkboxes inside a backlink snippet, anchored back to the source note.
 *
 * A snippet from `blockContextLinesAt` is a dedented reassembly of source
 * lines, rendered read-only through meowdown's `MarkdownView`. When the view
 * reports a checkbox click it identifies the task only by its document-order
 * index among the rendered checkboxes; this module enumerates the *same*
 * checkboxes from the snippet Markdown and pairs each with the write-back
 * coordinates ({@link TaskMarker}: whole-file `markerOffset` + `raw`) that the
 * task-toggle edit path already guards against staleness.
 *
 * The enumeration must mirror meowdown's rendering rule exactly — a drifted
 * index would toggle a *different* task, silently. Both sides parse with
 * Lezer's GFM grammar, and meowdown renders a checkbox for precisely the
 * `Task` nodes sitting in a **bullet** list item (`-`/`*`/`+`); a task marker
 * in an ordered list stays literal paragraph text. The click payload's
 * `checked`/`text` are cross-checked by the caller as a second line of
 * defense.
 */

/** One rendered checkbox in a snippet, with its source-note write-back anchor. */
export interface SnippetTask {
  /**
   * Whole-file offset of the marker's `[` in the source note, as of the read
   * that produced the snippet ({@link TaskMarker.markerOffset}). `-1` when the
   * snippet line had no recorded origin: the toggle's staleness guard then has
   * no positional trust and only accepts a unique `raw` relocation, refusing
   * an ambiguous line instead of guessing.
   */
  markerOffset: number
  /** The source marker line from `[` to the physical line end ({@link TaskMarker.raw}). */
  raw: string
  /** `[x]`/`[X]` → true, `[ ]` → false. */
  checked: boolean
  /**
   * True for Reflect's round task syntax (a `+` bullet) — the only kind the
   * Tasks projection covers and the only kind the snippet toggle writes.
   */
  round: boolean
  /** The line's content after the marker and one space — the view's click payload `text`. */
  text: string
}

function rawLineFor(
  snippet: string,
  starts: readonly number[],
  line: number,
  lineEnd: number,
  column: number,
  lineSourceTexts: readonly string[],
): string {
  const snippetLine = snippet.slice(starts[line]!, lineEnd)
  const sourceLine = lineSourceTexts[line]
  if (sourceLine === undefined || sourceLine.length < column + 3) {
    return snippetLine
  }
  return sourceLine
}

/** Start offset of every line of `text`. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

/** Index of the line containing `pos` (starts are sorted; linear scan, snippets are small). */
function lineIndexAt(starts: number[], pos: number): number {
  let line = 0
  while (line + 1 < starts.length && starts[line + 1]! <= pos) {
    line += 1
  }
  return line
}

/** Is this `Task` node one meowdown renders as a checkbox — a bullet list item's task? */
function isCheckboxTask(task: SyntaxNode): boolean {
  const item = task.parent
  if (item?.name !== 'ListItem' || item.parent?.name !== 'BulletList') {
    return false
  }
  return true
}

/**
 * Enumerate the checkboxes of one snippet in document order — the same order
 * (and count) meowdown's `MarkdownView` renders and reports click indexes in —
 * each anchored to its source-note marker offset via `lineOrigins`, the
 * per-line origins from `blockContextLinesAt`. When present,
 * `lineSourceTexts` carries the untrimmed source line for each displayed
 * snippet line, letting `raw` preserve trailing bytes that the snippet trims
 * away for rendering.
 */
export function extractSnippetTasks(
  snippet: string,
  lineOrigins: readonly number[],
  lineSourceTexts: readonly string[] = [],
): SnippetTask[] {
  if (snippet === '') {
    return []
  }
  const starts = lineStarts(snippet)
  const tasks: SnippetTask[] = []
  parseBody(snippet).iterate({
    enter: (node) => {
      if (node.name !== 'Task' || !isCheckboxTask(node.node)) {
        return
      }
      const markerFrom = node.from
      const marker = parseTaskMarker(snippet.slice(markerFrom, markerFrom + 3))
      const line = lineIndexAt(starts, markerFrom)
      const lineEndRaw = snippet.indexOf('\n', markerFrom)
      const lineEnd = lineEndRaw === -1 ? snippet.length : lineEndRaw
      const column = markerFrom - starts[line]!
      const origin = lineOrigins[line]
      const bullet = snippet.slice(starts[line]!, markerFrom)
      const sourceLine = rawLineFor(snippet, starts, line, lineEnd, column, lineSourceTexts)
      let textStart = markerFrom + 3
      if (snippet[textStart] === ' ') {
        textStart += 1
      }
      tasks.push({
        markerOffset: origin === undefined ? -1 : origin + column,
        raw: sourceLine.slice(column),
        // A `Task` node always carries a valid GFM marker; the parse is the
        // defensive read the toggle repeats against the live source.
        checked: marker?.checked === true,
        round: /^[\t ]*\+[\t ]+$/.test(bullet),
        text: snippet.slice(textStart, lineEnd),
      })
    },
  })
  return tasks
}
