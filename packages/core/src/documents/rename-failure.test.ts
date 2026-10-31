import { describe, expect, it } from 'vitest'
import { composeRenameFailure } from './rename-failure.ts'

describe('composeRenameFailure', () => {
  const FROM = 'Old Title'

  it('returns null when every phase held', () => {
    expect(composeRenameFailure(FROM, { rewrite: null, alias: null, move: null })).toBeNull()
  })

  it('a failed rewrite alone reports the alias safety net', () => {
    const message = composeRenameFailure(FROM, { rewrite: 'io error', alias: null, move: null })
    expect(message).toBe(
      'io error — links were not rewritten, but "Old Title" was kept as an alias so they still resolve',
    )
  })

  it('a failed alias alone reports that links were already rewritten', () => {
    const message = composeRenameFailure(FROM, { rewrite: null, alias: 'patch failed', move: null })
    expect(message).toBe(
      'links were rewritten, but recording "Old Title" as an alias failed: patch failed',
    )
  })

  it('both link phases failing is the only dangling-links case', () => {
    const message = composeRenameFailure(FROM, {
      rewrite: 'io error',
      alias: 'patch failed',
      move: null,
    })
    expect(message).toBe(
      'io error; the old-title alias also failed (patch failed) — links to "Old Title" may no longer resolve',
    )
  })

  it('a failed move alone is cosmetic: the file keeps its name', () => {
    const message = composeRenameFailure(FROM, { rewrite: null, alias: null, move: 'locked' })
    expect(message).toBe('the file keeps its old name (locked)')
  })

  it('a move failure appends to a link-phase failure', () => {
    const message = composeRenameFailure(FROM, { rewrite: 'io error', alias: null, move: 'locked' })
    expect(message).toBe(
      'io error — links were not rewritten, but "Old Title" was kept as an alias so they still resolve; the file keeps its old name (locked)',
    )
  })

  it('all three phases failing reports the dangling links and the kept filename', () => {
    const message = composeRenameFailure(FROM, {
      rewrite: 'io error',
      alias: 'patch failed',
      move: 'locked',
    })
    expect(message).toBe(
      'io error; the old-title alias also failed (patch failed) — links to "Old Title" may no longer resolve; the file keeps its old name (locked)',
    )
  })
})
