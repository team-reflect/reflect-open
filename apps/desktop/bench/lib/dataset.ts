/**
 * Deterministic large-graph fixture for the performance-pass benchmarks.
 *
 * Sized to stress the memoized hot paths: ~2 years of daily notes, ~1,500
 * ordinary notes, a deep pinned shelf, a full month of noted calendar dates,
 * and a realistic palette result set with highlight-marked snippets. A small
 * seeded PRNG keeps every run byte-identical so before/after comparisons differ
 * only by the code under test, never by the data.
 *
 * Benchmark-only — never imported by the app.
 */

import type { NoteEntry } from '@/components/command-palette/entries'
import type { RetrievalHit } from '@reflect/core'

/** Highlight markers parseHighlights scans (mirrors core's HIGHLIGHT_START/END). */
const MARK_START = String.fromCharCode(1)
const MARK_END = String.fromCharCode(2)

/** Mulberry32 — a tiny deterministic PRNG so fixtures never use Math.random. */
function makePrng(seed: number): () => number {
  let state = seed >>> 0
  return function next(): number {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let result = Math.imul(state ^ (state >>> 15), 1 | state)
    result = (result + Math.imul(result ^ (result >>> 7), 61 | result)) ^ result
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'meeting',
  'roadmap',
  'design',
  'sync',
  'retro',
  'idea',
  'reading',
  'project',
  'review',
  'standup',
  'plan',
  'notes',
  'sketch',
  'draft',
  'spec',
]

/** A fixed ISO date a fixed number of days before 2026-06-20 (today). */
function isoDaysBefore(daysBefore: number): string {
  const epochToday = Date.UTC(2026, 5, 20)
  const day = new Date(epochToday - daysBefore * 86_400_000)
  const year = day.getUTCFullYear()
  const month = String(day.getUTCMonth() + 1).padStart(2, '0')
  const date = String(day.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${date}`
}

export interface BenchDataset {
  /** Graph-relative paths of generated daily notes, newest first. */
  readonly dailyPaths: readonly string[]
  /** ISO dates of every generated daily note. */
  readonly dailyDates: readonly string[]
  /** Graph-relative paths of generated ordinary notes. */
  readonly notePaths: readonly string[]
  /** The pinned shelf: a deep list of sidebar rows. */
  readonly pinned: ReadonlyArray<{ path: string; title: string; date: string | null }>
  /** Noted calendar dates within the visible month (drives DayCalendar's Set). */
  readonly notedDatesInMonth: readonly string[]
  /** A realistic palette note-result set with highlight-marked snippets. */
  readonly paletteNotes: readonly NoteEntry[]
  /** Semantic neighbours for the similar-notes hook. */
  readonly similarHits: readonly RetrievalHit[]
}

export interface DatasetOptions {
  dailyCount?: number
  noteCount?: number
  pinnedCount?: number
  paletteResultCount?: number
}

/**
 * Build the shared benchmark dataset. Defaults stress the paths the
 * performance pass touched without being so large that the harness itself
 * dominates the measured component work.
 */
export function buildDataset(options: DatasetOptions = {}): BenchDataset {
  const dailyCount = options.dailyCount ?? 730
  const noteCount = options.noteCount ?? 1_500
  const pinnedCount = options.pinnedCount ?? 40
  const paletteResultCount = options.paletteResultCount ?? 50
  const random = makePrng(0x9e3779b9)

  const dailyDates: string[] = []
  const dailyPaths: string[] = []
  for (let index = 0; index < dailyCount; index += 1) {
    const date = isoDaysBefore(index)
    dailyDates.push(date)
    dailyPaths.push(`daily/${date}.md`)
  }

  const notePaths: string[] = []
  for (let index = 0; index < noteCount; index += 1) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!
    notePaths.push(`notes/${word}-${index}.md`)
  }

  const pinned: Array<{ path: string; title: string; date: string | null }> = []
  for (let index = 0; index < pinnedCount; index += 1) {
    if (index % 3 === 0) {
      const date = dailyDates[index % dailyDates.length]!
      pinned.push({ path: `daily/${date}.md`, title: date, date })
    } else {
      const path = notePaths[index % notePaths.length]!
      pinned.push({ path, title: `Pinned ${WORDS[index % WORDS.length]} ${index}`, date: null })
    }
  }

  const notedDatesInMonth: string[] = []
  for (let day = 1; day <= 28; day += 1) {
    if (random() > 0.25) {
      notedDatesInMonth.push(`2026-06-${String(day).padStart(2, '0')}`)
    }
  }

  const paletteNotes: NoteEntry[] = []
  for (let index = 0; index < paletteResultCount; index += 1) {
    const word = WORDS[index % WORDS.length]!
    paletteNotes.push({
      path: `notes/${word}-${index}.md`,
      title: `${word} ${index}`,
      date: null,
      snippet: `a ${word} note about ${MARK_START}query${MARK_END} terms and ${MARK_START}more${MARK_END} context ${index}`,
      phrase: null,
    })
  }

  const similarHits: RetrievalHit[] = []
  for (let index = 0; index < 6; index += 1) {
    similarHits.push({
      path: notePaths[index]!,
      title: `Similar ${index}`,
      score: 1 - index * 0.1,
      snippet: `neighbour snippet ${index}`,
      heading: null,
      isPrivate: false,
    })
  }

  return {
    dailyPaths,
    dailyDates,
    notePaths,
    pinned,
    notedDatesInMonth,
    paletteNotes,
    similarHits,
  }
}
