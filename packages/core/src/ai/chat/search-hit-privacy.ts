import { classifyAssetFromNotes } from '../../actions/asset-privacy'
import type { RetrievalHit } from '../../embeddings/retrieve'
import { chunkAssetDescriptionsWithAttribution, chunkNote } from '../../embeddings/chunk'
import { descriptionPathFor, isAssetPath } from '../../graph/paths'
import {
  MAX_ASSET_TEXT_CHARS,
  type AssetDescriptionBody,
} from '../../indexing/asset-description-text'
import { searchTerms } from '../../indexing/search-query'
import { canonicalAssetPath, parseNote } from '../../markdown/extract'
import { splitFrontmatter } from '../../markdown/frontmatter'

/** Effects needed to re-prove indexed search hits against the live graph. */
export interface SearchHitPrivacyDeps {
  readNoteFn: (path: string) => Promise<string>
  assetReferencingNotePathsFn: (assetPath: string) => Promise<string[]>
}

/** Provider-safe candidates plus every live source that justified them. */
export interface ResolvedSearchHits {
  hits: RetrievalHit[]
  attributions: SearchHitAttribution[]
}

/** Live sources that justified one returned note hit. */
export interface SearchHitAttribution {
  notePath: string
  assetPaths: string[]
}

interface ResolvedHit {
  hit: RetrievalHit
  assets: string[]
}

interface LiveAssetBody extends AssetDescriptionBody {
  effectiveBody: string
}

/**
 * Re-prove every indexed hit from fresh Markdown before it can enter a chat
 * tool result. Semantic chunks must exactly match a live note or attributed
 * asset chunk. Lexical hits are rebuilt from live note text; when only live,
 * sendable asset descriptions justify the match, the hit survives with an
 * empty snippet so the combined FTS document can never leak description text.
 */
export async function resolveSearchHitsForChat(
  query: string,
  hits: readonly RetrievalHit[],
  deps: SearchHitPrivacyDeps,
): Promise<ResolvedSearchHits> {
  const resolved = await Promise.all(
    hits.map(async (hit): Promise<ResolvedHit | null> => {
      try {
        return await resolveHit(query, hit, deps)
      } catch {
        return null
      }
    }),
  )
  const kept = resolved.filter((entry): entry is ResolvedHit => entry !== null)
  return {
    hits: kept.map((entry) => entry.hit),
    attributions: kept.map((entry) => ({
      notePath: entry.hit.path,
      assetPaths: entry.assets,
    })),
  }
}

async function resolveHit(
  query: string,
  hit: RetrievalHit,
  deps: SearchHitPrivacyDeps,
): Promise<ResolvedHit | null> {
  if (hit.isPrivate) {
    return null
  }
  const source = await deps.readNoteFn(hit.path)
  const parsed = parseNote({ path: hit.path, source })
  if (parsed.frontmatter.private) {
    return null
  }

  const liveHit = (snippet: string, heading: string | null): RetrievalHit => ({
    ...hit,
    title: parsed.title,
    snippet,
    heading,
    isPrivate: false,
  })

  if (hit.evidence.kind === 'semantic') {
    const evidence = hit.evidence
    const noteChunk = (await chunkNote(hit.path, source, parsed)).find((chunk) =>
      matchesSemanticEvidence(chunk, evidence),
    )
    if (noteChunk !== undefined) {
      return { hit: liveHit(noteChunk.text.trim(), noteChunk.heading), assets: [] }
    }

    const bodies = await readLiveAssetBodies(
      parsed.assets.map((asset) => asset.path),
      hit.evidence.assetPaths,
      deps,
    )
    const assetChunk = (
      await chunkAssetDescriptionsWithAttribution(bodies, source.length + 1)
    ).find((chunk) => matchesSemanticEvidence(chunk, evidence))
    if (assetChunk === undefined || !(await assetCanBeSent(assetChunk.assetPath, hit.path, deps))) {
      return null
    }
    return {
      hit: liveHit(assetChunk.text.trim(), assetChunk.heading),
      assets: [assetChunk.assetPath],
    }
  }

  const titleProof = lexicalProof(query, parsed.title)
  const bodyProof = lexicalProof(query, parsed.text)
  if (titleProof || bodyProof) {
    return {
      hit: liveHit(bodyProof ? liveNoteExcerpt(parsed.text) : '', null),
      assets: [],
    }
  }

  const bodies = await readLiveAssetBodies(
    parsed.assets.map((asset) => asset.path),
    hit.evidence.assetPaths,
    deps,
  )
  const sendableBodies: LiveAssetBody[] = []
  for (const body of bodies) {
    if (await assetCanBeSent(body.assetPath, hit.path, deps)) {
      sendableBodies.push(body)
    }
  }
  const contributing = lexicalAssetContributors(query, sendableBodies)
  if (contributing.length === 0) {
    return null
  }
  return { hit: liveHit('', null), assets: contributing }
}

function matchesSemanticEvidence(
  chunk: { posFrom: number; posTo: number; contentHash: string },
  evidence: Extract<RetrievalHit['evidence'], { kind: 'semantic' }>,
): boolean {
  return (
    chunk.posFrom === evidence.posFrom &&
    chunk.posTo === evidence.posTo &&
    chunk.contentHash === evidence.contentHash
  )
}

/** Read only current, canonical references; stale indexed references never justify a hit. */
async function readLiveAssetBodies(
  assetReferences: readonly string[],
  indexedCandidates: readonly string[],
  deps: SearchHitPrivacyDeps,
): Promise<LiveAssetBody[]> {
  const bodies: AssetDescriptionBody[] = []
  const seen = new Set<string>()
  const candidates = new Set(
    indexedCandidates.flatMap((path) => {
      const canonical = canonicalAssetPath(path)
      return canonical !== null && isAssetPath(canonical) ? [canonical] : []
    }),
  )
  for (const reference of assetReferences) {
    const canonical = canonicalAssetPath(reference)
    if (
      canonical === null ||
      !isAssetPath(canonical) ||
      !candidates.has(canonical) ||
      seen.has(canonical)
    ) {
      continue
    }
    seen.add(canonical)
    try {
      const description = await deps.readNoteFn(descriptionPathFor(canonical))
      const body = splitFrontmatter(description).body.trim()
      if (body !== '') {
        bodies.push({ assetPath: canonical, body })
      }
    } catch {
      // A missing, evicted, or unreadable sidecar cannot prove a provider hit.
    }
  }
  return withEffectiveLexicalBodies(bodies)
}

/** Reproduce the lexical fold's join-and-cap while retaining path attribution. */
function withEffectiveLexicalBodies(bodies: readonly AssetDescriptionBody[]): LiveAssetBody[] {
  const effective: LiveAssetBody[] = []
  let remaining = MAX_ASSET_TEXT_CHARS
  for (const body of bodies) {
    const joinerLength = effective.length === 0 ? 0 : 2
    if (remaining <= joinerLength) {
      break
    }
    remaining -= joinerLength
    const effectiveBody = body.body.slice(0, remaining)
    if (effectiveBody === '') {
      break
    }
    effective.push({ ...body, effectiveBody })
    remaining -= effectiveBody.length
    if (remaining === 0) {
      break
    }
  }
  return effective
}

async function assetCanBeSent(
  assetPath: string,
  currentNotePath: string,
  deps: SearchHitPrivacyDeps,
): Promise<boolean> {
  const candidates = new Set(await deps.assetReferencingNotePathsFn(assetPath))
  candidates.add(currentNotePath)
  return (await classifyAssetFromNotes(assetPath, [...candidates], deps.readNoteFn)) === 'send'
}

/**
 * Return exactly the live sendable assets needed to justify a lexical hit.
 * A single matching body wins; otherwise the safe combined fold may satisfy
 * terms distributed across several descriptions. Stored FTS snippets are
 * never reused for this path.
 */
function lexicalAssetContributors(query: string, bodies: readonly LiveAssetBody[]): string[] {
  for (const body of bodies) {
    if (lexicalProof(query, body.effectiveBody)) {
      return [body.assetPath]
    }
  }
  if (!lexicalProof(query, bodies.map((body) => body.effectiveBody).join('\n\n'))) {
    return []
  }
  const queryTokens = searchableTokens(query)
  return bodies
    .filter((body) => {
      const tokens = normalizedTokens(body.effectiveBody)
      return queryTokens.some((queryToken) => tokens.some((token) => token.startsWith(queryToken)))
    })
    .map((body) => body.assetPath)
}

/** Conservative, local proof compatible with FTS word-prefix matching. */
function lexicalProof(query: string, text: string): boolean {
  const queryTokens = searchableTokens(query)
  if (queryTokens.length === 0) {
    return false
  }
  const tokens = normalizedTokens(text)
  return queryTokens.every((queryToken) => tokens.some((token) => token.startsWith(queryToken)))
}

function searchableTokens(query: string): string[] {
  return searchTerms(query).flatMap(normalizedTokens)
}

function normalizedTokens(value: string): string[] {
  const folded = value.normalize('NFKD').replaceAll(/\p{M}/gu, '').toLowerCase()
  return folded.match(/[\p{L}\p{N}\p{Co}]+/gu) ?? []
}

function liveNoteExcerpt(text: string): string {
  const compact = text.trim().replaceAll(/\s+/g, ' ')
  return compact.length <= 320 ? compact : `${compact.slice(0, 319)}…`
}
