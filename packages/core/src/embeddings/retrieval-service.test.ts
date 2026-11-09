import { describe, expect, it } from 'vitest'
import {
  createNodeTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
  type TestNote,
} from '../testing/index.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from '../indexing/search.ts'
import { createSearchService } from '../indexing/search-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import {
  bestChunkPerNote,
  createRetrievalService,
  type FindAllOptions,
  fuseRanked,
  mergeNearestFirst,
  type ChunkHitRow,
  type RetrievalHit,
} from './retrieval-service.ts'

const MODEL = 'all-MiniLM-L6-v2'
const DIMENSIONS = 384

/**
 * A unit vector at `degrees` in the plane of the first two axes.
 */
function direction(degrees: number): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  const radians = (degrees * Math.PI) / 180
  vector[0] = Math.cos(radians)
  vector[1] = Math.sin(radians)
  return vector
}

/**
 * Topics as directions, first match wins: texts about nearby topics embed to
 * nearby vectors, and `gardening` is past the noise cutoff of all others.
 */
const TOPICS: ReadonlyArray<{ word: string; degrees: number }> = [
  { word: 'secret', degrees: 10 },
  { word: 'rust', degrees: 0 },
  { word: 'compiler', degrees: 20 },
  { word: 'gardening', degrees: 120 },
]

function embed(text: string): number[] {
  const topic = TOPICS.find(({ word }) => text.toLowerCase().includes(word))
  return direction(topic?.degrees ?? 180)
}

const NOTES: readonly TestNote[] = [
  { path: 'notes/rust.md', markdown: '# Rust\n\nRust has a borrow checker.\n' },
  { path: 'notes/compilers.md', markdown: '# Compilers\n\nA compiler lowers source to code.\n' },
  { path: 'notes/garden.md', markdown: '# Garden\n\nGardening needs patience.\n' },
  {
    path: 'notes/secret.md',
    markdown: '---\nprivate: true\n---\n\n# Secret\n\nA private rust project.\n',
  },
]

/**
 * A retrieval service over a graph of `notes` (default {@link NOTES}),
 * embedded through the real pipeline.
 */
async function setup(options?: {
  status?: EmbedStatus
  embedded?: boolean
  notes?: readonly TestNote[]
}) {
  const notes = options?.notes ?? NOTES
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
  })
  const logger = createTestLoggerService()
  if (options?.embedded !== false) {
    const index = createTestEmbeddingIndexService({
      database,
      noteFile,
      embeddingRuntime: createTestEmbeddingRuntimeService({ vectors: embed }),
      storeChunks: true,
    })
    await expect(
      index.backfill({ generation: 1, fileGeneration: 1, modelId: MODEL }),
    ).resolves.toBe('completed')
  }
  const runtime = createTestEmbeddingRuntimeService({
    vectors: embed,
    ...(options?.status === undefined ? {} : { status: options.status }),
  })
  const wikiResolver = createWikiResolverService({ database })
  const retrieval = createRetrievalService({
    database,
    search: createSearchService({ database, wikiResolver }),
    wikiResolver,
    embeddingRuntime: runtime,
    logger,
  })
  return { retrieval, runtime, logger }
}

describe('retrieve', () => {
  it('lexical mode ranks FTS matches and carries the snippet and the private flag', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.retrieve('borrow checker', { mode: 'lexical' })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/rust.md'])
    expect(hits[0]).toMatchObject({ title: 'Rust', score: 1, heading: null, isPrivate: false })
    expect(hits[0]!.snippet).toContain('borrow')
    expect(runtime.embedCalls()).toEqual([]) // no vector work on the lexical leg
  })

  it('lexical mode treats filter tokens as plain search terms', async () => {
    const { retrieval } = await setup()

    // As a palette filter `is:daily` would exclude every note here.
    const hits = await retrieval.retrieve('is:daily rust', { mode: 'lexical' })

    expect(hits).toEqual([])
  })

  it('semantic mode returns the nearest notes and drops neighbors past the cutoff', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.retrieve('the rust language', { mode: 'semantic' })

    // The compilers note is a 20° neighbor; gardening (120°) is noise.
    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/rust.md',
      'notes/secret.md',
      'notes/compilers.md',
    ])
    expect(hits[0]!.score).toBeCloseTo(1, 5)
    expect(hits[2]!.score).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3)
    expect(hits[0]).toMatchObject({ title: 'Rust', heading: 'Rust', isPrivate: false })
    expect(hits[0]!.snippet).toContain('Rust has a borrow checker.')
    expect(runtime.embedCalls()).toEqual([['the rust language']])
  })

  it('caps the hits at `limit`', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('the rust language', { mode: 'semantic', limit: 1 })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/rust.md'])
  })

  it('strips the content of private hits on request, keeping the hit and its flag', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('the rust language', {
      mode: 'semantic',
      excludePrivateContent: true,
    })

    const secret = hits.find((hit) => hit.path === 'notes/secret.md')
    expect(secret).toMatchObject({ title: 'Secret', snippet: '', heading: null, isPrivate: true })
    expect(hits.find((hit) => hit.path === 'notes/rust.md')!.snippet).not.toBe('')
  })

  it('hybrid mode (the default) fuses both legs: a note on both lists ranks first', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('compiler')

    // FTS finds only the compilers note; KNN adds its semantic neighbors.
    expect(hits[0]!.path).toBe('notes/compilers.md')
    expect(hits.map((hit) => hit.path).sort()).toEqual([
      'notes/compilers.md',
      'notes/rust.md',
      'notes/secret.md',
    ])
    expect(hits[0]!.score).toBeCloseTo(2 / 61, 10)
  })

  it('hybrid mode serves lexical hits and logs when the semantic leg fails', async () => {
    const { retrieval, logger } = await setup({ status: { status: 'uninitialized' } })

    const hits = await retrieval.retrieve('borrow checker')

    expect(hits.map((hit) => hit.path)).toEqual(['notes/rust.md'])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'semantic leg failed; serving lexical only:',
    ])
  })

  it('semantic mode rejects when the model is not ready', async () => {
    const { retrieval } = await setup({ status: { status: 'uninitialized' } })

    await expect(retrieval.retrieve('rust', { mode: 'semantic' })).rejects.toThrow(
      'embedding model is uninitialized',
    )
  })
})

/** Epoch ms of noon local time on `date`, a mid-day `mtime`. */
function localNoon(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day, 12).getTime()
}

const BEETS_GRAPH: readonly TestNote[] = [
  { path: 'daily/2026-05-20.md', markdown: '- Coffee with Andy and Bob\n', mtime: 1 },
  {
    path: 'daily/2026-07-14.md',
    markdown: '- Beets call with [[Andy]] and Bob\n  - battlestar galactica, bear-proof sheds\n',
    mtime: 2,
  },
  { path: 'daily/2026-09-02.md', markdown: '- Lunch with Andy only\n', mtime: 3 },
  { path: 'daily/2026-10-01.md', markdown: '- Andy and Bob: bears near the hives\n', mtime: 4 },
  {
    path: 'daily/2026-10-02.md',
    markdown: '---\nprivate: true\n---\n- Andy and Bob, privately\n',
    mtime: 5,
  },
  // A regular note last edited in August sorts among the dailies by that date.
  { path: 'notes/andy.md', markdown: '# Andy\n\nKnows Bob.\n', mtime: localNoon('2026-08-01') },
  { path: 'notes/bob.md', markdown: '# Bob\n\nGrows beets.\n', mtime: 7 },
  { path: 'templates/meeting.md', markdown: '# Meeting\n\nAndy and Bob.\n', mtime: 8 },
]

/** The paths `findAll` returns, or the refusal reason. */
async function foundPaths(
  groups: readonly (readonly string[])[],
  options: Partial<FindAllOptions> = {},
  notes: readonly TestNote[] = BEETS_GRAPH,
): Promise<string[] | string> {
  const { retrieval } = await setup({ notes, embedded: false })
  const result = await retrieval.findAll(groups, { limit: 30, ...options })
  return result.ok ? result.hits.map((hit) => hit.path) : result.reason
}

describe('findAll', () => {
  it('matches every group: any alternative within one, all groups together', async () => {
    // grep's (Andy|Bob) then (battle|bears): "battle" is a stem of "battlestar".
    await expect(
      foundPaths([
        ['Andy', 'Bob'],
        ['battle', 'bears'],
      ]),
    ).resolves.toEqual(['daily/2026-10-01.md', 'daily/2026-07-14.md'])
  })

  it('lists the most recent first, daily notes by date and others by last edit, never templates', async () => {
    await expect(foundPaths([['Andy'], ['Bob']])).resolves.toEqual([
      'daily/2026-10-01.md',
      'notes/andy.md',
      'daily/2026-07-14.md',
      'daily/2026-05-20.md',
    ])
  })

  it('returns the snippet around the matches, marked like search snippets', async () => {
    const { retrieval } = await setup({ notes: BEETS_GRAPH, embedded: false })

    const result = await retrieval.findAll([['bear-proof']], { limit: 30 })

    expect(result).toMatchObject({
      ok: true,
      hits: [{ path: 'daily/2026-07-14.md', heading: null, isPrivate: false }],
    })
    const snippet = result.ok ? result.hits[0]!.snippet : ''
    expect(snippet).toContain(`${HIGHLIGHT_START}bear-proof${HIGHLIGHT_END}`)
    expect(snippet).toContain('battlestar galactica,')
  })

  it('limits to daily notes dated within the inclusive range', async () => {
    await expect(foundPaths([['Andy']], { from: '2026-07-14', to: '2026-09-02' })).resolves.toEqual(
      ['daily/2026-09-02.md', 'daily/2026-07-14.md'],
    )
  })

  it('keeps only notes that link to a title', async () => {
    await expect(foundPaths([['Bob']], { linksTo: 'Andy' })).resolves.toEqual([
      'daily/2026-07-14.md',
    ])
  })

  it('refuses a link target that names no note instead of matching nothing', async () => {
    await expect(foundPaths([['Bob']], { linksTo: 'Andrew' })).resolves.toBe('unresolvedLink')
  })

  it('accepts a link target written as a wiki link', async () => {
    await expect(foundPaths([['Bob']], { linksTo: ' [[Andy]] ' })).resolves.toEqual([
      'daily/2026-07-14.md',
    ])
  })

  it('checks the link target even when no word is searchable', async () => {
    await expect(foundPaths([['--']], { linksTo: 'Andrew' })).resolves.toBe('unresolvedLink')
  })

  it('refuses a private link target exactly like a missing one', async () => {
    const notes: TestNote[] = [
      { path: 'notes/secret.md', markdown: '---\nprivate: true\n---\n# Secret plan\n' },
      { path: 'notes/hub.md', markdown: '# Hub\n\nAndy on [[Secret plan]].\n' },
    ]

    await expect(foundPaths([['Andy']], { linksTo: 'Secret plan' }, notes)).resolves.toBe(
      'unresolvedLink',
    )
  })

  it('leaves private notes out of the hits and the truncation flag', async () => {
    const { retrieval } = await setup({ notes: BEETS_GRAPH, embedded: false })

    // Three public dailies fill the limit; the private fourth must not read as "more".
    const result = await retrieval.findAll([['Andy'], ['Bob']], { limit: 3, from: '2026-01-01' })

    expect(result).toMatchObject({ ok: true, truncated: false })
    expect(result.ok ? result.hits.map((hit) => hit.path) : []).toEqual([
      'daily/2026-10-01.md',
      'daily/2026-07-14.md',
      'daily/2026-05-20.md',
    ])
  })

  it('keeps the newest matches and flags older ones past the limit', async () => {
    const { retrieval } = await setup({ notes: BEETS_GRAPH, embedded: false })

    const result = await retrieval.findAll([['Andy']], { limit: 2 })

    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok ? result.hits.map((hit) => hit.path) : []).toEqual([
      'daily/2026-10-01.md',
      'daily/2026-09-02.md',
    ])
  })

  it('keeps words ending in a one-character token as exact matches, so they still narrow', async () => {
    const notes: TestNote[] = [
      { path: 'notes/a.md', markdown: "# A\n\nBob's beets are up.\n" },
      { path: 'notes/b.md', markdown: '# B\n\nThe beets are up.\n' },
      { path: 'notes/c.md', markdown: '# C\n\nR&D budget for the beets.\n' },
    ]

    await expect(foundPaths([["Bob's beets"]], {}, notes)).resolves.toEqual(['notes/a.md'])
    await expect(foundPaths([['beets'], ['R&D']], {}, notes)).resolves.toEqual(['notes/c.md'])
  })

  it('refuses words the tokenizer drops instead of reporting no matches', async () => {
    await expect(foundPaths([['--']])).resolves.toBe('unsearchableWords')
    await expect(foundPaths([['Andy'], ['???']])).resolves.toBe('unsearchableWords')
  })

  it('refuses a range that ends before it starts', async () => {
    await expect(foundPaths([['Andy']], { from: '2026-10-31', to: '2026-06-01' })).resolves.toBe(
      'reversedRange',
    )
  })

  it('returns no snippet for a note matched only by its title', async () => {
    const notes: TestNote[] = [
      { path: 'notes/plan.md', markdown: '---\ntitle: Harvest plan\n---\nCrop rotation.\n' },
      { path: 'notes/log.md', markdown: '# Log\n\nHarvest went well.\n' },
    ]
    const { retrieval } = await setup({ notes, embedded: false })

    const result = await retrieval.findAll([['harvest']], { limit: 30 })

    const snippets = new Map(result.ok ? result.hits.map((hit) => [hit.path, hit.snippet]) : [])
    expect(snippets.get('notes/plan.md')).toBe('')
    expect(snippets.get('notes/log.md')).toContain(
      `${HIGHLIGHT_START}Harvest${HIGHLIGHT_END} went well.`,
    )
  })
})

describe('relatedNotes', () => {
  it('returns the neighbors of the stored vectors, without the note itself or private notes', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.relatedNotes('notes/rust.md')

    expect(hits.map((hit) => hit.path)).toEqual(['notes/compilers.md'])
    expect(hits[0]!.score).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3)
    expect(runtime.embedCalls()).toEqual([]) // seeded by stored vectors, never re-embedded
  })

  it('returns nothing for a note whose neighbors are all past the cutoff', async () => {
    const { retrieval } = await setup()

    await expect(retrieval.relatedNotes('notes/garden.md')).resolves.toEqual([])
  })

  it('returns nothing for a note that has no vectors yet', async () => {
    const { retrieval } = await setup({ embedded: false })

    await expect(retrieval.relatedNotes('notes/rust.md')).resolves.toEqual([])
  })

  it('caps the neighbors at `limit`', async () => {
    const { retrieval } = await setup()

    // The compilers note neighbors both rust notes; the private one never shows.
    await expect(retrieval.relatedNotes('notes/compilers.md', 1)).resolves.toHaveLength(1)
    await expect(retrieval.relatedNotes('notes/compilers.md', 0)).resolves.toEqual([])
  })
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
