import { isAppError } from '../errors'
import { readNoteLocal } from '../graph/commands'
import { descriptionPathFor } from '../graph/paths'
import { splitFrontmatter } from '../markdown/frontmatter'

/**
 * Folding asset descriptions into a note's search text (Plan 20, search
 * integration). A note's referenced assets each may have a description file
 * (`<asset>.reflect.md`); their bodies are appended to the note's FTS document
 * so a query matching a description surfaces the note — transparently, as an
 * ordinary hit. The same bodies feed the note's embedding chunks (the semantic
 * leg), so lexical and semantic retrieval see the same asset text. It never
 * enters the All-Notes preview or the note *content* AI reads — chat reaches
 * description text solely through the read_assets tool
 * (`ai/chat/read-assets.ts`), behind its own live privacy gate.
 */

/** Cap on folded description text per note (chars) — bounds the FTS document. */
export const MAX_ASSET_TEXT_CHARS = 8_000

/** One asset's description body, attributed to the asset it describes. */
export interface AssetDescriptionBody {
  /** Graph-relative asset path (`assets/x.png`), not the description path. */
  assetPath: string
  /** The description file's body, frontmatter stripped and trimmed. */
  body: string
}

/** What {@link gatherAssetDescriptionBodies} could (and could not) read. */
export interface AssetDescriptionGather {
  /** The readable description bodies, in reference order. */
  bodies: AssetDescriptionBody[]
  /**
   * Asset paths whose description file exists but is iCloud-evicted —
   * unreadable without forcing an on-demand download. Consumers that
   * *replace* stored derivations (the embedding pipeline's full chunk-set
   * apply) must skip the write entirely when this is non-empty, or the
   * evicted sidecar's previously indexed chunks are silently dropped.
   */
  evicted: string[]
}

/**
 * The per-asset description bodies for a note's referenced assets. Reads any
 * `<asset>.reflect.md` that exists (managed or user-authored — it is the
 * user's content about the asset) and strips frontmatter. Missing files and
 * empty bodies are skipped; an iCloud-evicted sidecar is reported in
 * `evicted` instead of being read (a read would block on an on-demand
 * download mid-pass); a repeated asset contributes once. Accumulation stops
 * once the combined length reaches {@link MAX_ASSET_TEXT_CHARS} (the body
 * that crosses the cap is kept whole — consumers apply their own final cap).
 * Reads are unpinned, matching the indexer's own note reads (the *write* is
 * generation-pinned, so a graph switch drops the stale row regardless).
 */
export async function gatherAssetDescriptionBodies(
  assetPaths: readonly string[],
): Promise<AssetDescriptionGather> {
  const bodies: AssetDescriptionBody[] = []
  const evicted: string[] = []
  if (assetPaths.length === 0) {
    return { bodies, evicted }
  }
  const seen = new Set<string>()
  let total = 0
  for (const assetPath of assetPaths) {
    if (seen.has(assetPath)) {
      continue // an asset referenced twice in one note contributes once
    }
    seen.add(assetPath)
    let read: Awaited<ReturnType<typeof readNoteLocal>>
    try {
      read = await readNoteLocal(descriptionPathFor(assetPath))
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue // no description for this asset (not generated yet, or none)
      }
      throw cause
    }
    if (read.kind === 'evicted') {
      evicted.push(assetPath)
      continue
    }
    const body = splitFrontmatter(read.content).body.trim()
    if (body === '') {
      continue
    }
    bodies.push({ assetPath, body })
    total += body.length
    if (total >= MAX_ASSET_TEXT_CHARS) {
      break
    }
  }
  return { bodies, evicted }
}

/**
 * The combined body text of a note's assets' description files, for folding
 * into its search index — {@link gatherAssetDescriptionBodies} joined and
 * capped at {@link MAX_ASSET_TEXT_CHARS}. An evicted sidecar's body is simply
 * absent here: the FTS document is rebuilt from the note file whenever the
 * note changes, so the fold catches up once the sidecar is local again —
 * unlike the embedding pipeline, nothing previously stored is destroyed.
 */
export async function gatherAssetDescriptionText(assetPaths: readonly string[]): Promise<string> {
  const { bodies } = await gatherAssetDescriptionBodies(assetPaths)
  return bodies
    .map((entry) => entry.body)
    .join('\n\n')
    .slice(0, MAX_ASSET_TEXT_CHARS)
}
