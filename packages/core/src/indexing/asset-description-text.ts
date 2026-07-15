import { isEligibleAssetPath } from '../actions/asset-description-helpers'
import { readManagedAssetDescription } from '../graph/commands'
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

/**
 * The per-asset description bodies for a note's referenced assets. Reads any
 * `<asset>.reflect.md` that exists (managed or user-authored — it is the
 * user's content about the asset) and strips frontmatter. Missing files and
 * empty bodies are skipped; a repeated asset contributes once. Accumulation
 * stops once the combined length reaches {@link MAX_ASSET_TEXT_CHARS} (the
 * body that crosses the cap is kept whole — consumers apply their own final
 * cap). `generation` pins callers whose surrounding operation is already
 * generation-scoped; indexer callers may omit it because their final write is
 * independently generation-pinned.
 */
export async function gatherAssetDescriptionBodies(
  assetPaths: readonly string[],
  generation?: number,
): Promise<AssetDescriptionBody[]> {
  if (assetPaths.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const bodies: AssetDescriptionBody[] = []
  let total = 0
  for (const assetPath of assetPaths) {
    if (!isEligibleAssetPath(assetPath) || seen.has(assetPath)) {
      continue // an asset referenced twice in one note contributes once
    }
    seen.add(assetPath)
    const source = await readManagedAssetDescription(assetPath, generation)
    if (source === null) {
      continue // no description for this asset (not generated yet, or none)
    }
    const body = splitFrontmatter(source).body.trim()
    if (body === '') {
      continue
    }
    bodies.push({ assetPath, body })
    total += body.length
    if (total >= MAX_ASSET_TEXT_CHARS) {
      break
    }
  }
  return bodies
}

/**
 * The combined body text of a note's assets' description files, for folding
 * into its search index — {@link gatherAssetDescriptionBodies} joined and
 * capped at {@link MAX_ASSET_TEXT_CHARS}.
 */
export async function gatherAssetDescriptionText(assetPaths: readonly string[]): Promise<string> {
  const bodies = await gatherAssetDescriptionBodies(assetPaths)
  return bodies
    .map((entry) => entry.body)
    .join('\n\n')
    .slice(0, MAX_ASSET_TEXT_CHARS)
}
