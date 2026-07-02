import { describe, expect, it } from 'vitest'
import { isOstensiblyEmptyNoteSource } from './note-emptiness'

describe('isOstensiblyEmptyNoteSource', () => {
  it('treats blank and frontmatter-only notes as empty', () => {
    expect(isOstensiblyEmptyNoteSource('')).toBe(true)
    expect(isOstensiblyEmptyNoteSource('\n  \n')).toBe(true)
    expect(isOstensiblyEmptyNoteSource('---\npinned: true\n---\n')).toBe(true)
  })

  it('treats plain empty bullets as empty', () => {
    expect(isOstensiblyEmptyNoteSource('- ')).toBe(true)
    expect(isOstensiblyEmptyNoteSource('  *\n\n+   \n')).toBe(true)
  })

  it('treats bullet content as authored content', () => {
    expect(isOstensiblyEmptyNoteSource('- groceries\n')).toBe(false)
  })
})
