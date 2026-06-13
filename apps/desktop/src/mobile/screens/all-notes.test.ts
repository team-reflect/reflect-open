import { describe, expect, it } from 'vitest'
import { searchQueryWithTag } from './all-notes'

/**
 * The route tag must constrain typed searches (the badge stays honest while
 * searching) without duplicating a `#tag` token the user typed themselves.
 */
describe('searchQueryWithTag', () => {
  it('passes the parsed query through when no tag is active', () => {
    const parsed = searchQueryWithTag('meeting notes', null)
    expect(parsed.text).toBe('meeting notes')
    expect(parsed.filters.tags).toEqual([])
  })

  it('merges the active route tag as a folded filter', () => {
    const parsed = searchQueryWithTag('meeting', 'Book')
    expect(parsed.filters.tags).toEqual(['book'])
    expect(parsed.filtered).toBe(true)
    expect(parsed.text).toBe('meeting')
  })

  it('does not duplicate a tag the query already carries', () => {
    const parsed = searchQueryWithTag('#book meeting', 'Book')
    expect(parsed.filters.tags).toEqual(['book'])
  })
})
