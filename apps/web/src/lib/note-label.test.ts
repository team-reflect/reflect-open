import { describe, expect, it } from 'vitest'
import { formatNoteLabel } from './note-label.ts'

describe('formatNoteLabel', () => {
  it('names a daily note by its day in the chosen date format', () => {
    const note = { path: 'daily/2026-06-09.md', title: '2026-06-09' }
    expect(formatNoteLabel(note, 'mdy')).toBe('Tue, June 9th, 2026')
    expect(formatNoteLabel(note, 'dmy')).toBe('Tue, 9th June, 2026')
    expect(formatNoteLabel(note, 'iso')).toBe('2026-06-09')
  })

  it('names a daily note by its day even when it has an authored title', () => {
    const note = { path: 'daily/2026-06-09.md', title: 'Trip' }
    expect(formatNoteLabel(note, 'mdy')).toBe('Tue, June 9th, 2026')
  })

  it('names any other note by its display title', () => {
    const note = { path: 'notes/a.md', title: 'Alpha // Beta' }
    expect(formatNoteLabel(note, 'mdy')).toBe('Alpha')
  })

  it('names a daily note whose path is not a real calendar day by that date', () => {
    const note = { path: 'daily/2026-13-45.md', title: '2026-13-45' }
    expect(formatNoteLabel(note, 'mdy')).toBe('2026-13-45')
  })
})
