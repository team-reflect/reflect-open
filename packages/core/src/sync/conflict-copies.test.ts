import { describe, expect, it } from 'vitest'
import { describeConflictCopies } from './conflict-copies.ts'

describe('describeConflictCopies', () => {
  it('names one copy by its graph path', () => {
    expect(
      describeConflictCopies(['assets/data (conflict 2026-10-16 08-05-31 a1b2c3d4).json']),
    ).toBe('Kept a conflict copy: assets/data (conflict 2026-10-16 08-05-31 a1b2c3d4).json')
  })

  it('lists every copy in full, never truncated', () => {
    const paths = [
      'a/one (conflict x).json',
      'b/two (conflict y).mp3',
      'c/three (conflict z).txt',
      'd/four (conflict w).zip',
    ]
    expect(describeConflictCopies(paths)).toBe(`Kept 4 conflict copies: ${paths.join(', ')}`)
  })
})
