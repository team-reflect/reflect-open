import { isAppError } from '../errors'
import { readNote } from '../graph/commands'
import { descriptionPathFor } from '../graph/paths'
import { splitFrontmatter } from '../markdown/frontmatter'

/**
 * Folding asset descriptions into a note's search text (Plan 20, search
 * integration). A note's referenced assets each may have a description file
 * (`<asset>.reflect.md`); their bodies are appended to the note's FTS document
 * so a query matching a description surfaces the note — transparently, as an
 * ordinary hit. The text goes into `search_fts.body` only, never the All-Notes
 * preview or AI-reachable note text.
 */

/** Cap on folded description text per note (chars) — bounds the FTS document. */
export const MAX_ASSET_TEXT_CHARS = 8_000

/**
 * The combined body text of a note's assets' description files, for folding
 * into its search index. Reads any `<asset>.reflect.md` that exists (managed or
 * user-authored — it is the user's content about the asset), strips frontmatter,
 * joins the bodies, and caps the total. Missing files are skipped. Reads are
 * unpinned, matching the indexer's own note reads (the *write* is
 * generation-pinned, so a graph switch drops the stale row regardless).
 */
export async function gatherAssetDescriptionText(assetPaths: readonly string[]): Promise<string> {
  if (assetPaths.length === 0) {
    return ''
  }
  const seen = new Set<string>()
  const bodies: string[] = []
  let total = 0
  for (const assetPath of assetPaths) {
    if (seen.has(assetPath)) {
      continue // an asset referenced twice in one note contributes once
    }
    seen.add(assetPath)
    let source: string
    try {
      source = await readNote(descriptionPathFor(assetPath))
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue // no description for this asset (not generated yet, or none)
      }
      throw cause
    }
    const body = splitFrontmatter(source).body.trim()
    if (body === '') {
      continue
    }
    bodies.push(body)
    total += body.length
    if (total >= MAX_ASSET_TEXT_CHARS) {
      break
    }
  }
  return bodies.join('\n\n').slice(0, MAX_ASSET_TEXT_CHARS)
}
