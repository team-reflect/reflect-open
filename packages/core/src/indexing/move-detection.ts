/**
 * Id-based move pairing (Plan 17). A note's frontmatter `id` is its durable
 * identity; the filename is a projection of the title. When a row's file
 * vanishes and a new file appears carrying the same id — an external rename,
 * a sync-pulled rename, anything Reflect didn't perform itself — the pair is
 * a *move*, and treating it as delete+create would silently drop the row's
 * embedding vectors (a re-embed of identical content costs the user BYOK
 * money).
 *
 * Pure: the reconcile pass and the watcher batch handler both feed it their
 * own (path → id) views.
 */

/** One detected rename: the row at `from` belongs to the file at `to`. */
export interface DetectedMove {
  from: string
  to: string
}

/**
 * Pair vanished rows with appeared files by frontmatter id. Only non-null
 * ids participate, and an id claimed by more than one path on either side
 * never pairs — that's a rename/rename fork or a hand-copied id, which the
 * duplicate-id surface reports for review; guessing a move there could wire
 * one note's history to another's file.
 *
 * ```ts
 * pairMovesById(
 *   new Map([['notes/01abc.md', 'id-1']]),        // row whose file vanished
 *   new Map([['notes/meeting.md', 'id-1']]),      // file that appeared
 * )
 * // → [{ from: 'notes/01abc.md', to: 'notes/meeting.md' }]
 * ```
 */
export function pairMovesById(
  orphans: ReadonlyMap<string, string | null>,
  arrivals: ReadonlyMap<string, string | null>,
): DetectedMove[] {
  const orphansById = groupByIdUnambiguous(orphans)
  const arrivalsById = groupByIdUnambiguous(arrivals)
  const moves: DetectedMove[] = []
  for (const [id, from] of orphansById) {
    const to = arrivalsById.get(id)
    if (to !== undefined) {
      moves.push({ from, to })
    }
  }
  return moves
}

/** id → path, keeping only ids claimed by exactly one path. */
function groupByIdUnambiguous(entries: ReadonlyMap<string, string | null>): Map<string, string> {
  const byId = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const [path, id] of entries) {
    if (id === null) {
      continue
    }
    if (byId.has(id)) {
      ambiguous.add(id)
    } else {
      byId.set(id, path)
    }
  }
  for (const id of ambiguous) {
    byId.delete(id)
  }
  return byId
}
