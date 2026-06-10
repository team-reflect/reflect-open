import { describe, expect, it } from 'vitest'
import { cosineDistanceFromUnitL2, fuseRanked, type RetrievalHit } from './retrieve'

function hit(path: string, overrides?: Partial<RetrievalHit>): RetrievalHit {
  return {
    path,
    title: path,
    score: 0,
    snippet: `about ${path}`,
    heading: null,
    isPrivate: false,
    ...overrides,
  }
}

describe('fuseRanked (reciprocal rank fusion)', () => {
  it('a note ranked in both lists beats single-list notes', () => {
    const lexical = [hit('notes/both.md'), hit('notes/lex-only.md')]
    const semantic = [hit('notes/sem-only.md'), hit('notes/both.md')]
    const fused = fuseRanked([lexical, semantic], 10)
    expect(fused[0].path).toBe('notes/both.md')
    expect(fused).toHaveLength(3)
  })

  it('preserves single-list order and respects the limit', () => {
    const lexical = [hit('a'), hit('b'), hit('c')]
    const fused = fuseRanked([lexical], 2)
    expect(fused.map((entry) => entry.path)).toEqual(['a', 'b'])
  })

  it('fills an empty snippet from the other list and is deterministic', () => {
    const semantic = [hit('a', { snippet: '' })]
    const lexical = [hit('a', { snippet: 'lexical snippet' })]
    const fused = fuseRanked([semantic, lexical], 5)
    expect(fused[0].snippet).toBe('lexical snippet')
    expect(fuseRanked([semantic, lexical], 5)).toEqual(fused)
  })

  it('keeps the private flag through fusion', () => {
    const fused = fuseRanked([[hit('p', { isPrivate: true })]], 5)
    expect(fused[0].isPrivate).toBe(true)
  })
})

describe('cosineDistanceFromUnitL2', () => {
  it('maps identical unit vectors (l2 = 0) to cosine distance 0', () => {
    expect(cosineDistanceFromUnitL2(0)).toBe(0)
  })

  it('maps orthogonal unit vectors (l2 = √2) to cosine distance 1', () => {
    expect(cosineDistanceFromUnitL2(Math.SQRT2)).toBeCloseTo(1)
  })

  it('maps opposite unit vectors (l2 = 2) to cosine distance 2', () => {
    expect(cosineDistanceFromUnitL2(2)).toBe(2)
  })
})
