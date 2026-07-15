import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  bestChunkPerNote,
  fuseRanked,
  mergeNearestFirst,
  retrieve,
  type ChunkHitRow,
  type RetrievalHit,
} from './retrieve'

afterEach(() => {
  setBridge(null)
})

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

const ASSET_SENTINEL = 'asset-description-sentinel-01k0'

interface RetrievalBridgeOptions {
  readonly lexical?: ReadonlyArray<{
    readonly path: string
    readonly title: string
    readonly snippet: string
  }>
  readonly semantic?: readonly ChunkHitRow[]
  readonly previews: Readonly<Record<string, string>>
  readonly privatePaths?: readonly string[]
}

/** Bridge fake that exposes distinct FTS, embedding, privacy-flag, and preview queries. */
function installRetrievalBridge(options: RetrievalBridgeOptions): void {
  const privatePaths = new Set(options.privatePaths ?? [])
  setBridge({
    invoke: async (command, args) => {
      if (command === 'embed_texts') {
        return [[0.5, 0.5]]
      }
      if (command !== 'db_query') {
        throw new Error(`unexpected command: ${command}`)
      }

      const query = String(args['sql'])
      if (query.includes('embedding_vectors') && query.includes('embedding MATCH')) {
        return (options.semantic ?? []).map((entry) => ({
          path: entry.path,
          title: entry.title,
          heading: entry.heading,
          text: entry.text,
          is_private: entry.isPrivate,
          distance: entry.distance,
        }))
      }
      if (query.includes('search_fts')) {
        return (options.lexical ?? []).map((entry, index) => ({
          path: entry.path,
          title: entry.title,
          daily_date: null,
          preview: options.previews[entry.path] ?? '',
          mtime: 1_000 - index,
          is_pinned: 0,
          fts_highlighted_title: entry.title,
          snippet: entry.snippet,
        }))
      }
      if (query.includes('"is_private"')) {
        return [...new Set([...(options.lexical ?? []).map((entry) => entry.path)])].map(
          (path) => ({ path, is_private: privatePaths.has(path) ? 1 : 0 }),
        )
      }
      if (query.includes('"preview"')) {
        return Object.entries(options.previews).map(([path, preview]) => ({ path, preview }))
      }
      throw new Error(`unexpected db query: ${query}`)
    },
    listen: async () => () => {},
  })
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

describe('retrieve — external AI snippets', () => {
  it('replaces lexical FTS asset text with note-only previews and keeps private hits empty', async () => {
    installRetrievalBridge({
      lexical: [
        { path: 'notes/public.md', title: 'Public', snippet: ASSET_SENTINEL },
        { path: 'notes/private.md', title: 'Private', snippet: ASSET_SENTINEL },
      ],
      previews: {
        'notes/public.md': 'Public note-only preview.',
        'notes/private.md': 'Private note-only preview.',
      },
      privatePaths: ['notes/private.md'],
    })

    const hits = await retrieve('sentinel', {
      mode: 'lexical',
      excludePrivateContent: true,
    })

    expect(hits.map((entry) => entry.path)).toEqual(['notes/public.md', 'notes/private.md'])
    expect(hits[0]).toMatchObject({
      snippet: 'Public note-only preview.',
      heading: null,
      isPrivate: false,
    })
    expect(hits[1]).toMatchObject({ snippet: '', heading: null, isPrivate: true })
    expect(JSON.stringify(hits)).not.toContain(ASSET_SENTINEL)
    expect(JSON.stringify(hits)).not.toContain('Private note-only preview.')
  })

  it('replaces semantic asset chunks with note-only previews and clears their headings', async () => {
    installRetrievalBridge({
      semantic: [
        row('notes/public.md', 0.1, {
          heading: 'private-scan.pdf',
          text: ASSET_SENTINEL,
        }),
        row('notes/private.md', 0.2, {
          heading: 'private-photo.png',
          text: ASSET_SENTINEL,
          isPrivate: 1,
        }),
      ],
      previews: {
        'notes/public.md': 'Public semantic preview.',
        'notes/private.md': 'Private semantic preview.',
      },
    })

    const hits = await retrieve('sentinel', {
      mode: 'semantic',
      excludePrivateContent: true,
    })

    expect(hits[0]).toMatchObject({
      path: 'notes/public.md',
      snippet: 'Public semantic preview.',
      heading: null,
    })
    expect(hits[1]).toMatchObject({
      path: 'notes/private.md',
      snippet: '',
      heading: null,
    })
    expect(JSON.stringify(hits)).not.toContain(ASSET_SENTINEL)
    expect(JSON.stringify(hits)).not.toContain('private-scan.pdf')
  })

  it('preserves hybrid ranking and rich local snippets while sanitizing cloud results', async () => {
    installRetrievalBridge({
      lexical: [
        { path: 'notes/both.md', title: 'Both', snippet: `lexical ${ASSET_SENTINEL}` },
        { path: 'notes/lexical.md', title: 'Lexical', snippet: `lexical ${ASSET_SENTINEL}` },
      ],
      semantic: [
        row('notes/semantic.md', 0.1, {
          heading: 'diagram.png',
          text: `semantic ${ASSET_SENTINEL}`,
        }),
        row('notes/both.md', 0.2, {
          heading: 'shared.pdf',
          text: `semantic ${ASSET_SENTINEL}`,
        }),
      ],
      previews: {
        'notes/both.md': 'Both note preview.',
        'notes/lexical.md': 'Lexical note preview.',
        'notes/semantic.md': 'Semantic note preview.',
      },
    })

    const local = await retrieve('sentinel', {
      mode: 'hybrid',
      excludePrivateContent: false,
    })
    const external = await retrieve('sentinel', {
      mode: 'hybrid',
      excludePrivateContent: true,
    })

    expect(external.map(({ path, score }) => ({ path, score }))).toEqual(
      local.map(({ path, score }) => ({ path, score })),
    )
    expect(JSON.stringify(local)).toContain(ASSET_SENTINEL)
    expect(Object.fromEntries(external.map((entry) => [entry.path, entry.snippet]))).toEqual({
      'notes/both.md': 'Both note preview.',
      'notes/lexical.md': 'Lexical note preview.',
      'notes/semantic.md': 'Semantic note preview.',
    })
    expect(external.every((entry) => entry.heading === null)).toBe(true)
    expect(JSON.stringify(external)).not.toContain(ASSET_SENTINEL)
  })
})
