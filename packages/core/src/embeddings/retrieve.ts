import { sql } from 'kysely'
import { db } from '../indexing/db'
import { searchWithFilters } from '../indexing/filtered-search'
import type { ParsedSearchQuery } from '../indexing/filter-query'
import { embedTexts } from './commands'

/**
 * The shared retrieval contract (Plan 09): one `retrieve()` for search and AI.
 * Lexical = FTS (title-boosted); semantic = embed the query, KNN over chunks,
 * dedupe to best chunk per note; hybrid = reciprocal rank fusion of the two
 * (deterministic, no tuned weights). Private notes stay locally recallable —
 * `excludePrivateContent` strips their *content* for callers that ship hits to
 * external services (Plan 10), enforced again at the AI boundary.
 */

export interface RetrievalHit {
  path: string
  title: string
  score: number
  /** Chunk text (semantic) or highlight-markered FTS snippet (lexical). */
  snippet: string
  heading: string | null
  isPrivate: boolean
}

export interface RetrieveOptions {
  limit?: number
  mode?: 'semantic' | 'lexical' | 'hybrid'
  /** AI callers set true: private hits keep title/flag but lose content. */
  excludePrivateContent?: boolean
}

const KNN_CANDIDATES = 24

interface ChunkHitRow {
  path: string
  title: string
  heading: string | null
  text: string
  isPrivate: number
  distance: number
}

async function semanticHits(query: string, limit: number): Promise<RetrievalHit[]> {
  const [vector] = await embedTexts([query])
  const result = await sql<ChunkHitRow>`
    SELECT c.note_path AS path, n.title, c.heading, c.text,
           n.is_private AS isPrivate, v.distance
    FROM embedding_vectors v
    JOIN embedding_chunks c ON c.id = v.rowid
    JOIN notes n ON n.path = c.note_path
    WHERE v.embedding MATCH ${JSON.stringify(vector)} AND k = ${KNN_CANDIDATES}
    ORDER BY v.distance
  `.execute(db)

  // Best chunk per note wins; distance maps to a similarity-ish score
  // (lower distance = higher score) for callers that want magnitudes.
  const byNote = new Map<string, RetrievalHit>()
  for (const row of result.rows) {
    if (!byNote.has(row.path)) {
      byNote.set(row.path, {
        path: row.path,
        title: row.title,
        score: 1 / (1 + row.distance),
        snippet: row.text.trim(),
        heading: row.heading,
        isPrivate: row.isPrivate !== 0,
      })
    }
  }
  return [...byNote.values()].slice(0, limit)
}

async function lexicalHits(query: string, limit: number): Promise<RetrievalHit[]> {
  // Deliberately UNPARSED: retrieve() receives raw text (often from AI
  // callers, Plan 10) where palette filter tokens like "is:daily" inside a
  // sentence must stay literal search terms, not become constraints.
  const plain: ParsedSearchQuery = {
    text: query,
    filters: {
      tags: [],
      dailyOnly: false,
      linksTo: null,
      linkedFrom: null,
      updatedAfterMs: null,
      updatedBeforeMs: null,
    },
    filtered: false,
  }
  const hits = await searchWithFilters(plain, limit)
  if (hits.length === 0) {
    return []
  }
  const flags = await db
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

/** Reciprocal rank fusion: order-based, scale-free, deterministic. */
export function fuseRanked(lists: RetrievalHit[][], limit: number): RetrievalHit[] {
  const K = 60 // the standard RRF damping constant
  const fused = new Map<string, { hit: RetrievalHit; score: number }>()
  for (const list of lists) {
    list.forEach((hit, index) => {
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
    })
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }))
}

/** Strip private notes' content while keeping the hit + flag. */
function withPrivacy(hits: RetrievalHit[], excludePrivateContent: boolean): RetrievalHit[] {
  if (!excludePrivateContent) {
    return hits
  }
  return hits.map((hit) => (hit.isPrivate ? { ...hit, snippet: '', heading: null } : hit))
}

export async function retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]> {
  const limit = options?.limit ?? 12
  const mode = options?.mode ?? 'hybrid'
  const excludePrivateContent = options?.excludePrivateContent ?? false

  if (mode === 'lexical') {
    return withPrivacy(await lexicalHits(query, limit), excludePrivateContent)
  }
  if (mode === 'semantic') {
    return withPrivacy(await semanticHits(query, limit), excludePrivateContent)
  }
  // Hybrid degrades, never breaks: a failing semantic leg (embed error, vec
  // query error — even while the runtime claims ready) must not take lexical
  // search down with it. A failing lexical leg is a real error and throws.
  const [lexical, semantic] = await Promise.all([
    lexicalHits(query, limit),
    semanticHits(query, limit).catch((cause): RetrievalHit[] => {
      console.error('semantic leg failed; serving lexical only:', cause)
      return []
    }),
  ])
  return withPrivacy(fuseRanked([lexical, semantic], limit), excludePrivateContent)
}

/**
 * Semantic neighbors of an existing note, seeded by its own **stored** lead
 * chunk vector — no re-embedding, no pane-provided seed text: the embedding
 * sync keeps chunks current on every save, and the index invalidation scope
 * refetches consumers, so freshness is automatic. Returns [] when the note
 * has no vectors yet (model never enabled, or not yet embedded).
 */
export async function relatedNotes(path: string, limit = 6): Promise<RetrievalHit[]> {
  const seed = await sql<{ vec: string }>`
    SELECT vec_to_json(v.embedding) AS vec
    FROM embedding_chunks c
    JOIN embedding_vectors v ON v.rowid = c.id
    WHERE c.note_path = ${path}
    ORDER BY c.pos_from
    LIMIT 1
  `.execute(db)
  const vec = seed.rows[0]?.vec
  if (vec === undefined) {
    return []
  }
  const result = await sql<ChunkHitRow>`
    SELECT c.note_path AS path, n.title, c.heading, c.text,
           n.is_private AS isPrivate, v.distance
    FROM embedding_vectors v
    JOIN embedding_chunks c ON c.id = v.rowid
    JOIN notes n ON n.path = c.note_path
    WHERE v.embedding MATCH ${vec} AND k = ${KNN_CANDIDATES}
    ORDER BY v.distance
  `.execute(db)
  const byNote = new Map<string, RetrievalHit>()
  for (const row of result.rows) {
    if (row.path !== path && !byNote.has(row.path)) {
      byNote.set(row.path, {
        path: row.path,
        title: row.title,
        score: 1 / (1 + row.distance),
        snippet: row.text.trim(),
        heading: row.heading,
        isPrivate: row.isPrivate !== 0,
      })
    }
  }
  return [...byNote.values()].slice(0, limit)
}
