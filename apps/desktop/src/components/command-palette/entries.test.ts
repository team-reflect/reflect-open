import { describe, expect, it } from 'vitest'
import type { AppCommand } from '@/lib/commands/types'
import type { FilteredSearchHit, WikiSuggestion } from '@reflect/core'
import { buildPaletteSections } from './entries'

function suggestion(path: string, title: string, date: string | null = null): WikiSuggestion {
  return { target: title, path, title, alias: null, date }
}
function hit(
  path: string,
  title: string,
  snippet: string | null = '…body…',
  dailyDate: string | null = null,
): FilteredSearchHit {
  return { path, title, snippet, dailyDate }
}
const COMMANDS: AppCommand[] = [
  { id: 'nav.today', title: 'Go to today', keywords: ['daily'], run: () => {} },
  { id: 'theme.toggle', title: 'Toggle theme', keywords: ['dark'], run: () => {} },
]

/** Defaults for the common case; tests override what they exercise. */
function sections(
  overrides: Partial<Parameters<typeof buildPaletteSections>[0]> & { query: string },
) {
  return buildPaletteSections({
    dataQuery: overrides.query,
    suggestions: [],
    hits: [],
    filtered: false,
    commands: [],
    ...overrides,
  })
}

describe('buildPaletteSections', () => {
  it('an empty query is the recall feed: suggestions only, no commands', () => {
    const result = sections({
      query: '',
      suggestions: [suggestion('notes/a.md', 'Alpha')],
      commands: COMMANDS,
    })
    expect(result.notes.map((note) => note.path)).toEqual(['notes/a.md'])
    expect(result.commands).toEqual([])
    expect(result.commandsOnly).toBe(false)
  })

  it('a cleared input ignores data still answering the previous query', () => {
    const result = sections({
      query: '',
      dataQuery: 'rust', // the deferred value hasn't caught up yet
      suggestions: [suggestion('notes/rust.md', 'Rust')],
      hits: [hit('notes/stale.md', 'Stale Hit')],
    })
    expect(result.notes).toEqual([]) // momentarily empty beats momentarily wrong
  })

  it('body hits never join the recall feed, even when present', () => {
    // Defensive belt: the search query is disabled for an empty input, but if
    // an array arrives anyway the recall feed stays suggestions-only.
    const result = sections({ query: '', hits: [hit('notes/stale.md', 'Stale Hit')] })
    expect(result.notes).toEqual([])
  })

  it('title matches lead and search hits dedupe behind them', () => {
    const result = sections({
      query: 'alpha',
      suggestions: [suggestion('notes/a.md', 'Alpha')],
      hits: [hit('notes/a.md', 'Alpha'), hit('notes/b.md', 'Beta', 'about alpha')],
    })
    expect(result.notes.map((note) => note.path)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(result.notes[0]!.snippet).toBeNull() // the title form won
    expect(result.notes[1]!.snippet).toContain('alpha')
  })

  it('a daily body hit keeps its day label in the merge', () => {
    const result = sections({
      query: 'standup',
      hits: [hit('daily/2026-06-05.md', '2026-06-05', 'standup notes', '2026-06-05')],
    })
    expect(result.notes[0]!.date).toBe('2026-06-05')
  })

  it('a not-yet-created daily (pathless suggestion) is still jumpable', () => {
    const result = sections({
      query: '2026-08-01',
      suggestions: [
        { target: '2026-08-01', path: null, title: '2026-08-01', alias: null, date: '2026-08-01' },
      ],
    })
    expect(result.notes).toEqual([
      { path: 'daily/2026-08-01.md', title: '2026-08-01', date: '2026-08-01', snippet: null },
    ])
  })

  it('commands match on title and keywords once a query exists', () => {
    const result = sections({ query: 'dark', commands: COMMANDS })
    expect(result.commands.map((command) => command.id)).toEqual(['theme.toggle'])
  })

  it('a > prefix filters to commands only', () => {
    const result = sections({
      query: '> today',
      suggestions: [suggestion('notes/today-plan.md', 'Today plan')],
      commands: COMMANDS,
    })
    expect(result.commandsOnly).toBe(true)
    expect(result.notes).toEqual([])
    expect(result.commands.map((command) => command.id)).toEqual(['nav.today'])
  })

  it('filtered mode: hits are the list — no merge, no commands', () => {
    const result = sections({
      query: '#work is:daily',
      suggestions: [suggestion('notes/ignored.md', 'Ignored')],
      hits: [
        hit('daily/2026-06-08.md', '2026-06-08', null, '2026-06-08'),
        hit('notes/w.md', 'Work log', 'tagged …'),
      ],
      filtered: true,
      commands: COMMANDS,
    })
    expect(result.notes.map((note) => note.path)).toEqual(['daily/2026-06-08.md', 'notes/w.md'])
    expect(result.notes[0]!.date).toBe('2026-06-08')
    expect(result.commands).toEqual([])
  })

  it('deleting filter tokens leaves constrained mode immediately', () => {
    // Live query is plain text; the deferred data still answers the previous
    // filtered query. Mode follows the live input — merge view, live command
    // matching — and the mode-mismatched rows are dropped, not shown.
    const result = sections({
      query: 'go today',
      dataQuery: '#work go today',
      hits: [hit('notes/w.md', 'Work log', null)],
      filtered: true,
      commands: COMMANDS,
    })
    expect(result.notes).toEqual([]) // stale constrained rows never render
    expect(result.commands.map((command) => command.id)).toEqual(['nav.today'])
  })

  it('adding filter tokens enters constrained mode immediately', () => {
    // Live query gained tokens; the deferred data is still the plain merge.
    const result = sections({
      query: '#work plan',
      dataQuery: 'plan',
      suggestions: [suggestion('notes/p.md', 'Plan')],
      hits: [hit('notes/p.md', 'Plan')],
      filtered: false,
      commands: COMMANDS,
    })
    expect(result.notes).toEqual([]) // plain-merge rows don't pose as filtered
    expect(result.commands).toEqual([])
  })

  it('a cleared input ignores filtered rows still answering the previous query', () => {
    const result = sections({
      query: '',
      dataQuery: '#work', // the deferred filter query hasn't caught up
      hits: [hit('notes/w.md', 'Work log', null)],
      filtered: true,
    })
    expect(result.notes).toEqual([])
  })

  it('daily suggestions keep their date for day-label rendering', () => {
    const result = sections({
      query: '2026',
      suggestions: [
        {
          target: '2026-06-09',
          path: 'daily/2026-06-09.md',
          title: '2026-06-09',
          alias: null,
          date: '2026-06-09',
        },
      ],
    })
    expect(result.notes[0]!.date).toBe('2026-06-09')
  })
})
