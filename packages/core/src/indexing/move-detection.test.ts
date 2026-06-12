import { describe, expect, it } from 'vitest'
import { pairMovesById } from './move-detection'

function entries(pairs: Array<[string, string | null]>): Map<string, string | null> {
  return new Map(pairs)
}

describe('pairMovesById', () => {
  it('pairs a vanished row with an appeared file sharing its id', () => {
    expect(
      pairMovesById(
        entries([['notes/old.md', 'id-1']]),
        entries([['notes/new.md', 'id-1']]),
      ),
    ).toEqual([{ from: 'notes/old.md', to: 'notes/new.md' }])
  })

  it('pairs multiple distinct ids independently', () => {
    const moves = pairMovesById(
      entries([
        ['notes/a-old.md', 'id-a'],
        ['notes/b-old.md', 'id-b'],
      ]),
      entries([
        ['notes/b-new.md', 'id-b'],
        ['notes/a-new.md', 'id-a'],
      ]),
    )
    expect(moves).toContainEqual({ from: 'notes/a-old.md', to: 'notes/a-new.md' })
    expect(moves).toContainEqual({ from: 'notes/b-old.md', to: 'notes/b-new.md' })
    expect(moves).toHaveLength(2)
  })

  it('never pairs null ids (legacy files without frontmatter identity)', () => {
    expect(
      pairMovesById(entries([['notes/old.md', null]]), entries([['notes/new.md', null]])),
    ).toEqual([])
  })

  it('never pairs an id claimed by two arrivals (rename/rename fork)', () => {
    expect(
      pairMovesById(
        entries([['notes/old.md', 'id-1']]),
        entries([
          ['notes/fork-a.md', 'id-1'],
          ['notes/fork-b.md', 'id-1'],
        ]),
      ),
    ).toEqual([])
  })

  it('never pairs an id claimed by two orphans (hand-copied id)', () => {
    expect(
      pairMovesById(
        entries([
          ['notes/copy-1.md', 'id-1'],
          ['notes/copy-2.md', 'id-1'],
        ]),
        entries([['notes/new.md', 'id-1']]),
      ),
    ).toEqual([])
  })

  it('unmatched sides simply do not pair', () => {
    expect(
      pairMovesById(
        entries([['notes/old.md', 'id-1']]),
        entries([['notes/new.md', 'id-2']]),
      ),
    ).toEqual([])
  })
})
