import { describe, expect, it } from 'vitest'
import {
  bestChunkPerNote,
  fuseRanked,
  mergeNearestFirst,
  type ChunkHitRow,
  type RetrievalHit,
} from './retrieve'

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

function row(path: string, distance: number, overrides?: Partial<ChunkHitRow>): ChunkHitRow {
  return {
    path,
    title: path,
    heading: null,
    text: ` about ${path} `,
    isPrivate: 0,
    distance,
    ...overrides,
  }
}

describe('bestChunkPerNote', () => {
  it('drops neighbors past the cosine noise cutoff (gibberish queries find nothing)', () => {
    const rows = [row('notes/a.md', 0.84), row('notes/b.md', 0.92)]
    expect(bestChunkPerNote(rows, 12)).toEqual([])
  })

  it('keeps near matches while dropping the noisy tail', () => {
    const rows = [row('notes/match.md', 0.3), row('notes/noise.md', 0.75)]
    const hits = bestChunkPerNote(rows, 12)
    expect(hits.map((hit) => hit.path)).toEqual(['notes/match.md'])
  })

  it('collapses to the best chunk per note, scored as cosine similarity', () => {
    const rows = [
      row('notes/a.md', 0.2, { text: 'best chunk' }),
      row('notes/a.md', 0.4, { text: 'worse chunk' }),
    ]
    const hits = bestChunkPerNote(rows, 12)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toBe('best chunk')
    expect(hits[0]!.score).toBeCloseTo(0.8)
  })

  it('excludes the seed note and respects the limit', () => {
    const rows = [row('notes/self.md', 0.0), row('notes/a.md', 0.1), row('notes/b.md', 0.2)]
    const hits = bestChunkPerNote(rows, 1, 'notes/self.md')
    expect(hits.map((hit) => hit.path)).toEqual(['notes/a.md'])
  })

  it('trims snippets and converts the private flag', () => {
    const hits = bestChunkPerNote([row('notes/p.md', 0.1, { isPrivate: 1 })], 12)
    expect(hits[0]!.snippet).toBe('about notes/p.md')
    expect(hits[0]!.isPrivate).toBe(true)
  })
})

describe('mergeNearestFirst (multi-seed related notes)', () => {
  it('interleaves seed lists by distance so every seed contributes', () => {
    const fromLeadChunk = [row('notes/morning.md', 0.3), row('notes/noise.md', 0.6)]
    const fromLaterChunk = [row('notes/afternoon.md', 0.4)]
    const merged = mergeNearestFirst([fromLeadChunk, fromLaterChunk])
    expect(merged.map((entry) => entry.path)).toEqual([
      'notes/morning.md',
      'notes/afternoon.md',
      'notes/noise.md',
    ])
  })

  it('a neighbor found only by a later seed survives bestChunkPerNote', () => {
    const fromLeadChunk = [row('notes/self.md', 0.0)]
    const fromLaterChunk = [row('notes/self.md', 0.0), row('notes/afternoon.md', 0.4)]
    const merged = mergeNearestFirst([fromLeadChunk, fromLaterChunk])
    const hits = bestChunkPerNote(merged, 10, 'notes/self.md')
    expect(hits.map((hit) => hit.path)).toEqual(['notes/afternoon.md'])
  })

  it('a note hit by several seeds keeps its best distance', () => {
    const fromLeadChunk = [row('notes/both.md', 0.5, { text: 'far chunk' })]
    const fromLaterChunk = [row('notes/both.md', 0.2, { text: 'near chunk' })]
    const hits = bestChunkPerNote(mergeNearestFirst([fromLeadChunk, fromLaterChunk]), 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toBe('near chunk')
    expect(hits[0]!.score).toBeCloseTo(0.8)
  })
})

describe('fuseRanked (reciprocal rank fusion)', () => {
  it('a note ranked in both lists beats single-list notes', () => {
    const lexical = [hit('notes/both.md'), hit('notes/lex-only.md')]
    const semantic = [hit('notes/sem-only.md'), hit('notes/both.md')]
    const fused = fuseRanked([lexical, semantic], 10)
    expect(fused[0]!.path).toBe('notes/both.md')
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
    expect(fused[0]!.snippet).toBe('lexical snippet')
    expect(fuseRanked([semantic, lexical], 5)).toEqual(fused)
  })

  it('keeps the private flag through fusion', () => {
    const fused = fuseRanked([[hit('p', { isPrivate: true })]], 5)
    expect(fused[0]!.isPrivate).toBe(true)
  })
})