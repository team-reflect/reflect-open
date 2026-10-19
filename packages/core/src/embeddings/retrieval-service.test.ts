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
import { createSearchService } from '../indexing/search-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import { createRetrievalService } from './retrieval-service.ts'

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
 * A retrieval service over a graph of {@link NOTES}, embedded through the real pipeline.
 */
async function setup(options?: { status?: EmbedStatus; embedded?: boolean }) {
  const database = createNodeTestDatabaseService()
  seedNotes(database, NOTES)
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(NOTES.map((note) => [note.path, note.markdown])),
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
  const retrieval = createRetrievalService({
    database,
    search: createSearchService({
      database,
      wikiResolver: createWikiResolverService({ database }),
    }),
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
