import { describe, expect, it } from 'vitest'
import type { FilteredSearchHit, NoteTagFacet } from '@reflect/core'
import { matchingTagFacets, rowForHit } from './all-notes'

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
    const row = rowForHit(hit({ snippet: 'a \u0001match\u0002 here' }))
    expect(row.snippet).toEqual([
      { text: 'a ', highlighted: false },
      { text: 'match', highlighted: true },
      { text: ' here', highlighted: false },
    ])
  })

  it('falls back to the stored preview when no text was searched', () => {
    const row = rowForHit(hit({ preview: 'First line of the note.' }))
    expect(row.snippet).toEqual([{ text: 'First line of the note.', highlighted: false }])
  })

  it('renders no snippet line for an empty preview', () => {
    expect(rowForHit(hit({})).snippet).toEqual([])
  })

  it('highlights free-text matches in the note title', () => {
    const row = rowForHit(
      hit({ title: 'Tim MacCaw', highlightedTitle: '\u0001Tim Mac\u0002Caw' }),
    )
    expect(row.titleSegments).toEqual([
      { text: 'Tim Mac', highlighted: true },
      { text: 'Caw', highlighted: false },
    ])
  })

  it('uses the index title markers for tokenizer-normalized matches', () => {
    const row = rowForHit(
      hit({ title: 'Café Alpha', highlightedTitle: '\u0001Café\u0002 Alpha' }),
    )
    expect(row.titleSegments).toEqual([
      { text: 'Café', highlighted: true },
      { text: ' Alpha', highlighted: false },
    ])
  })

  it('does not highlight a body-only query that appears inside the title', () => {
    const row = rowForHit(hit({ title: 'Oscar plans', highlightedTitle: 'Oscar plans' }))
    expect(row.titleSegments).toEqual([{ text: 'Oscar plans', highlighted: false }])
  })
})

describe('matchingTagFacets', () => {
  const facets: NoteTagFacet[] = [
    { tag: 'Book', count: 3 },
    { tag: 'notebook', count: 1 },
    { tag: 'work', count: 5 },
  ]

  it('matches case-insensitively on folded substrings', () => {
    expect(matchingTagFacets(facets, 'boo').map((facet) => facet.tag)).toEqual([
      'Book',
      'notebook',
    ])
  })

  it('lists every tag for a bare # (empty partial)', () => {
    expect(matchingTagFacets(facets, '')).toHaveLength(3)
  })
})
