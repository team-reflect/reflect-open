import { describe, expect, it } from 'vitest'
import type { AppCommand } from '@/lib/commands/types'
import type { RankedSearchHit, WikiSuggestion } from '@reflect/core'
import { buildPaletteSections } from './entries'

function suggestion(path: string, title: string, date: string | null = null): WikiSuggestion {
  return { target: title, path, title, alias: null, date }
}
function hit(path: string, title: string, snippet = '…body…'): RankedSearchHit {
  return { path, title, snippet }
}
const COMMANDS: AppCommand[] = [
  { id: 'nav.today', title: 'Go to today', keywords: ['daily'], run: () => {} },
  { id: 'theme.toggle', title: 'Toggle theme', keywords: ['dark'], run: () => {} },
]

describe('buildPaletteSections', () => {
  it('an empty query is the recall feed: suggestions only, no commands', () => {
    const sections = buildPaletteSections({
      query: '',
      suggestions: [suggestion('notes/a.md', 'Alpha')],
      hits: [],
      commands: COMMANDS,
    })
    expect(sections.notes.map((note) => note.path)).toEqual(['notes/a.md'])
    expect(sections.commands).toEqual([])
    expect(sections.commandsOnly).toBe(false)
  })

  it('an empty query ignores lagging FTS hits (recall feed only)', () => {
    // The deferred index query can still hold the previous search's results
    // when the input is cleared — they must not leak into the recall feed.
    const sections = buildPaletteSections({
      query: '',
      suggestions: [],
      hits: [hit('notes/stale.md', 'Stale Hit')],
      commands: [],
    })
    expect(sections.notes).toEqual([])
  })

  it('title matches lead and FTS hits dedupe behind them', () => {
    const sections = buildPaletteSections({
      query: 'alpha',
      suggestions: [suggestion('notes/a.md', 'Alpha')],
      hits: [hit('notes/a.md', 'Alpha'), hit('notes/b.md', 'Beta', 'about alpha')],
      commands: [],
    })
    expect(sections.notes.map((note) => note.path)).toEqual(['notes/a.md', 'notes/b.md'])
    expect(sections.notes[0].snippet).toBeNull() // the title form won
    expect(sections.notes[1].snippet).toContain('alpha')
  })

  it('a not-yet-created daily (pathless suggestion) is still jumpable', () => {
    const sections = buildPaletteSections({
      query: '2026-08-01',
      suggestions: [
        { target: '2026-08-01', path: null, title: '2026-08-01', alias: null, date: '2026-08-01' },
      ],
      hits: [],
      commands: [],
    })
    expect(sections.notes).toEqual([
      { path: 'daily/2026-08-01.md', title: '2026-08-01', date: '2026-08-01', snippet: null },
    ])
  })

  it('commands match on title and keywords once a query exists', () => {
    const sections = buildPaletteSections({
      query: 'dark',
      suggestions: [],
      hits: [],
      commands: COMMANDS,
    })
    expect(sections.commands.map((command) => command.id)).toEqual(['theme.toggle'])
  })

  it('a > prefix filters to commands only', () => {
    const sections = buildPaletteSections({
      query: '> today',
      suggestions: [suggestion('notes/today-plan.md', 'Today plan')],
      hits: [],
      commands: COMMANDS,
    })
    expect(sections.commandsOnly).toBe(true)
    expect(sections.notes).toEqual([])
    expect(sections.commands.map((command) => command.id)).toEqual(['nav.today'])
  })

  it('daily suggestions keep their date for day-label rendering', () => {
    const sections = buildPaletteSections({
      query: '2026',
      suggestions: [
        { target: '2026-06-09', path: 'daily/2026-06-09.md', title: '2026-06-09', alias: null, date: '2026-06-09' },
      ],
      hits: [],
      commands: [],
    })
    expect(sections.notes[0].date).toBe('2026-06-09')
  })
})
