import { sql } from 'kysely'
import type { LoggerService } from '../ports/logger-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { literalSearchQuery } from '../indexing/filter-query.ts'
import type { SearchService } from '../indexing/search-service.ts'
import type { EmbeddingRuntimeService } from './embedding-runtime-service.ts'

/**
 * The shared retrieval contract (Plan 09): one `retrieve()` for search and AI.
 * Lexical = FTS (title-boosted); semantic = embed the query, KNN over chunks,
 * drop neighbors past the noise cutoff, dedupe to best chunk per note;
 * hybrid = reciprocal rank fusion of the two
 * (deterministic, no tuned weights). Private notes stay locally recallable —
 * `excludePrivateContent` strips their *content* for callers that ship hits to
 * external services (Plan 10), enforced again at the AI boundary.
 */

export interface RetrievalHit {
  path: string
  title: string
  score: number
  /**
   * Chunk text (semantic) or highlight-markered FTS snippet (lexical).
   */
  snippet: string
  heading: string | null
  isPrivate: boolean
}

export interface RetrieveOptions {
  limit?: number
  mode?: 'semantic' | 'lexical' | 'hybrid'
  /**
   * AI callers set true: private hits keep title/flag but lose content.
   */
  excludePrivateContent?: boolean
}

const KNN_CANDIDATES = 24

/**
 * Neighbors farther than this cosine distance are noise, not matches: KNN
 * always fills the candidate list with the nearest chunks however unrelated
 * they are (worst in small graphs), so without a cutoff a gibberish query
 * still "finds" notes. 0.7 is the old app's tuned cutoff for the same model
 * family, carried over for parity; with all-MiniLM-L6-v2 it also separates
 * query→chunk matching cleanly (real matches land under ~0.65, gibberish and
 * unrelated queries at ~0.72+). The `embedding_vectors` table's metric is
 * cosine (migration 0003), so vec0 distances threshold directly.
 */
const MAX_COSINE_DISTANCE = 0.7

export interface ChunkHitRow {
  path: string
  title: string
  heading: string | null
  text: string
  isPrivate: number
  distance: number
}

/**
 * Collapse KNN chunk rows (ordered nearest-first) into one hit per note —
 * the best chunk wins. Rows past {@link MAX_COSINE_DISTANCE} are dropped
 * rather than padded in, and `excludePath` removes the seed note itself when
 * the query came from a stored note vector. The score is cosine similarity
 * (the vec0 table's metric is cosine) for callers that want magnitudes.
 */
export function bestChunkPerNote(
  rows: readonly ChunkHitRow[],
  limit: number,
  excludePath?: string,
): RetrievalHit[] {
  const byNote = new Map<string, RetrievalHit>()
  for (const row of rows) {
    if (row.distance > MAX_COSINE_DISTANCE) {
      continue
    }
    if (row.path === excludePath || byNote.has(row.path)) {
      continue
    }
    byNote.set(row.path, {
      path: row.path,
      title: row.title,
      score: 1 - row.distance,
      snippet: row.text.trim(),
      heading: row.heading,
      isPrivate: row.isPrivate !== 0,
    })
  }
  return [...byNote.values()].slice(0, limit)
}

/**

 * Reciprocal rank fusion: order-based, scale-free, deterministic.

 */
export function fuseRanked(lists: RetrievalHit[][], limit: number): RetrievalHit[] {
  const K = 60 // the standard RRF damping constant
  const fused = new Map<string, { hit: RetrievalHit; score: number }>()
  for (const list of lists) {
    for (const [index, hit] of list.entries()) {
      const entry = fused.get(hit.path)
      const score = 1 / (K + index + 1)
      if (entry) {
        entry.score += score
        // Prefer a snippet-bearing form when one side lacks content.
        if (entry.hit.snippet === '' && hit.snippet !== '') {
          entry.hit = { ...hit }
        }
      } else {
        fused.set(hit.path, { hit: { ...hit }, score })
      }
    }
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }))
}

/**

 * Strip private notes' content while keeping the hit + flag.

 */
function withPrivacy(hits: RetrievalHit[], excludePrivateContent: boolean): RetrievalHit[] {
  if (!excludePrivateContent) {
    return hits
  }
  return hits.map((hit) => (hit.isPrivate ? { ...hit, snippet: '', heading: null } : hit))
}

/**
 * KNN result lists from several seed vectors, merged nearest-first so
 * {@link bestChunkPerNote} keeps each note's best distance across seeds.
 */
export function mergeNearestFirst(lists: ReadonlyArray<readonly ChunkHitRow[]>): ChunkHitRow[] {
  return lists.flat().sort((a, b) => a.distance - b.distance)
}

/**
 * Seed-vector cap for {@link RetrievalService.relatedNotes}: one KNN query runs per seed, so
 * a pathological note (a huge import) must not turn every sidebar refetch
 * into hundreds of queries. Sixteen seeds cover ~16k chars of note text —
 * past any real daily note — before later topics stop influencing neighbors.
 */
const MAX_RELATED_SEEDS = 16

/**

 * The one retrieval contract that search and AI share (Plan 09).

 */
export interface RetrievalService {
  /**
   * The notes matching `query`. `lexical` is FTS, `semantic` is KNN over the
   * chunk vectors, and `hybrid` (the default) fuses both; a failing semantic
   * leg degrades `hybrid` to lexical. At most `limit` hits (default 12).
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]>
  /**
   * Semantic neighbors of an existing note, seeded by its own **stored** chunk
   * vectors — no re-embedding, no pane-provided seed text: the embedding sync
   * keeps chunks current on every save, so a call always reads the note as it
   * was last embedded. Callers own their own refresh cadence (the desktop panel
   * computes once per note per session); this is a read, and a costly one.
   * Every chunk seeds its own
   * KNN pass (capped at {@link MAX_RELATED_SEEDS}) and the lists merge
   * nearest-first, so a multi-topic note — a daily note above all — surfaces
   * neighbors for anything written in it, not just its lead paragraph.
   * Returns [] when the note has no vectors yet (model never enabled, or not
   * yet embedded). Candidates past {@link MAX_COSINE_DISTANCE} are dropped
   * rather than padded in, so a sparse graph shows few (or no) neighbors
   * instead of wrong ones.
   */
  relatedNotes(path: string, limit?: number): Promise<RetrievalHit[]>
}

export interface RetrievalServiceDeps {
  readonly database: DatabaseService
  readonly search: SearchService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly logger: LoggerService
}

class RetrievalServiceImpl implements RetrievalService {
  readonly #deps: RetrievalServiceDeps

  constructor(deps: RetrievalServiceDeps) {
    this.#deps = deps
  }

  async retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]> {
    const limit = options?.limit ?? 12
    const mode = options?.mode ?? 'hybrid'
    const excludePrivateContent = options?.excludePrivateContent ?? false

    if (mode === 'lexical') {
      return withPrivacy(await this.#lexicalHits(query, limit), excludePrivateContent)
    }
    if (mode === 'semantic') {
      return withPrivacy(await this.#semanticHits(query, limit), excludePrivateContent)
    }
    // Hybrid degrades, never breaks: a failing semantic leg (embed error, vec
    // query error — even while the runtime claims ready) must not take lexical
    // search down with it. A failing lexical leg is a real error and throws.
    const [lexical, semantic] = await Promise.all([
      this.#lexicalHits(query, limit),
      this.#semanticHits(query, limit).catch((cause): RetrievalHit[] => {
        this.#deps.logger.error('semantic leg failed; serving lexical only:', cause)
        return []
      }),
    ])
    return withPrivacy(fuseRanked([lexical, semantic], limit), excludePrivateContent)
  }

  async relatedNotes(path: string, limit = 10): Promise<RetrievalHit[]> {
    const { database } = this.#deps
    const seeds = await sql<{ vec: string }>`
      SELECT vec_to_json(v.embedding) AS vec
      FROM embedding_chunks c
      JOIN embedding_vectors v ON v.rowid = c.id
      WHERE c.note_path = ${path}
      ORDER BY c.pos_from
      LIMIT ${MAX_RELATED_SEEDS}
    `.execute(database.db)
    if (seeds.rows.length === 0) {
      return []
    }
    const neighborLists = await Promise.all(
      seeds.rows.map(async (seed) => {
        const result = await sql<ChunkHitRow>`
          SELECT c.note_path AS path, n.title, c.heading, c.text,
                 n.is_private AS isPrivate, v.distance
          FROM embedding_vectors v
          JOIN embedding_chunks c ON c.id = v.rowid
          JOIN notes n ON n.path = c.note_path
          WHERE v.embedding MATCH ${seed.vec} AND k = ${KNN_CANDIDATES}
            AND n.is_private = 0
          ORDER BY v.distance
        `.execute(database.db)
        return result.rows
      }),
    )
    return bestChunkPerNote(mergeNearestFirst(neighborLists), limit, path)
  }

  async #semanticHits(query: string, limit: number): Promise<RetrievalHit[]> {
    const { database, embeddingRuntime } = this.#deps
    const [vector] = await embeddingRuntime.embedTexts([query])
    const result = await sql<ChunkHitRow>`
      SELECT c.note_path AS path, n.title, c.heading, c.text,
             n.is_private AS isPrivate, v.distance
      FROM embedding_vectors v
      JOIN embedding_chunks c ON c.id = v.rowid
      JOIN notes n ON n.path = c.note_path
      WHERE v.embedding MATCH ${JSON.stringify(vector)} AND k = ${KNN_CANDIDATES}
      ORDER BY v.distance
    `.execute(database.db)
    return bestChunkPerNote(result.rows, limit)
  }

  async #lexicalHits(query: string, limit: number): Promise<RetrievalHit[]> {
    const { database, search } = this.#deps
    // Literal on purpose: retrieve() receives raw text (often from AI callers,
    // Plan 10) where palette filter tokens like "is:daily" inside a sentence
    // must stay search terms, not become constraints.
    const hits = await search.searchWithFilters(literalSearchQuery(query), { limit })
    if (hits.length === 0) {
      return []
    }
    const flags = await database.db
      .selectFrom('notes')
      .where(
        'path',
        'in',
        hits.map((hit) => hit.path),
      )
      .select(['path', 'isPrivate'])
      .execute()
    const privateByPath = new Map(flags.map((row) => [row.path, row.isPrivate !== 0]))
    return hits.map((hit, index) => ({
      path: hit.path,
      title: hit.title,
      score: 1 / (1 + index), // FTS rank order; raw bm25 scores are not exposed
      snippet: hit.snippet ?? '',
      heading: null,
      isPrivate: privateByPath.get(hit.path) ?? false,
    }))
  }
}

export function createRetrievalService(deps: RetrievalServiceDeps): RetrievalService {
  return new RetrievalServiceImpl(deps)
}
