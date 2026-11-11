import { describe, expect, it } from 'vitest'
import type { FilteredSearchHit, NoteTagFacet } from '@reflect/core'
import { matchingTagFacets, rowForHit } from './all-notes.tsx'

function hit(overrides: Partial<FilteredSearchHit>): FilteredSearchHit {
  return {
    path: 'notes/a.md',
    title: 'A',
    highlightedTitle: 'A',
    dailyDate: null,
    snippet: null,
    preview: '',
    mtime: 0,
    isPinned: false,
    ...overrides,
  }
}

describe('rowForHit', () => {
  it('renders an FTS snippet as highlighted segments', () => {
    // \u0001/\u0002 are the index's highlight markers (core's search.ts).
    const row = rowForHit(hit({ snippet: 'a \u{1}match\u{2} here' }), 'mdy')
    expect(row.snippet).toEqual([
      { text: 'a ', highlighted: false },
      { text: 'match', highlighted: true },
      { text: ' here', highlighted: false },
    ])
  })

  it('falls back to the stored preview when no text was searched', () => {
    const row = rowForHit(hit({ preview: 'First line of the note.' }), 'mdy')
    expect(row.snippet).toEqual([{ text: 'First line of the note.', highlighted: false }])
  })

  it('renders no snippet line for an empty preview', () => {
    expect(rowForHit(hit({}), 'mdy').snippet).toEqual([])
  })

  it('highlights free-text matches in the note title', () => {
    const row = rowForHit(
      hit({ title: 'Tim MacCaw', highlightedTitle: '\u{1}Tim Mac\u{2}Caw' }),
      'mdy',
    )
    expect(row.titleSegments).toEqual([
      { text: 'Tim Mac', highlighted: true },
      { text: 'Caw', highlighted: false },
    ])
  })

  it('uses the index title markers for tokenizer-normalized matches', () => {
    const row = rowForHit(
      hit({ title: 'Café Alpha', highlightedTitle: '\u{1}Café\u{2} Alpha' }),
      'mdy',
    )
    expect(row.titleSegments).toEqual([
      { text: 'Café', highlighted: true },
      { text: ' Alpha', highlighted: false },
    ])
  })

  it('does not highlight a body-only query that appears inside the title', () => {
    const row = rowForHit(hit({ title: 'Oscar plans', highlightedTitle: 'Oscar plans' }), 'mdy')
    expect(row.titleSegments).toEqual([{ text: 'Oscar plans', highlighted: false }])
  })

  it('allows regular notes, but not daily notes, to expose delete', () => {
    expect(rowForHit(hit({ path: 'notes/a.md', dailyDate: null }), 'mdy').canDelete).toBe(true)
    expect(
      rowForHit(hit({ path: 'daily/2026-08-15.md', dailyDate: '2026-08-15' }), 'mdy').canDelete,
    ).toBe(false)
  })

  it('titles a daily note by its day in the chosen date format, without highlights', () => {
    const daily = hit({
      path: 'daily/2026-08-15.md',
      title: '2026-08-15',
      highlightedTitle: '\u{1}2026\u{2}-08-15',
      dailyDate: '2026-08-15',
    })
    expect(rowForHit(daily, 'mdy').titleSegments).toEqual([
      { text: 'Sat, August 15th, 2026', highlighted: false },
    ])
    expect(rowForHit(daily, 'iso').titleSegments).toEqual([
      { text: '2026-08-15', highlighted: false },
    ])
  })
})

describe('matchingTagFacets', () => {
  const facets: NoteTagFacet[] = [
    { tag: 'Book', count: 3 },
    { tag: 'notebook', count: 1 },
    { tag: 'work', count: 5 },
  ]

  it('matches case-insensitively on folded substrings', () => {
    expect(matchingTagFacets(facets, 'boo').map((facet) => facet.tag)).toEqual(['Book', 'notebook'])
  })

  it('lists every tag for a bare # (empty partial)', () => {
    expect(matchingTagFacets(facets, '')).toHaveLength(3)
  })
})
