import { noteExists } from '../graph/commands'
import { notePath } from '../graph/paths'
import { db } from './db'

/**
 * Collision-free note-path selection (Plan 17). New notes are
 * `notes/<slug>.md`; when that's taken, `<slug>-2.md`, `-3`, … — the suffix is
 * the entire collision policy (no id-tails on every filename for the rare
 * clash). A candidate is taken when **either** the index has a row for it or
 * the file exists on disk: the index lags the watcher by a debounce, and an
 * unindexed file must never be clobbered by a new note's slug.
 */

/** Is `path` already taken — indexed, or present on disk? */
async function pathTaken(path: string): Promise<boolean> {
  const row = await db
    .selectFrom('notes')
    .where('path', '=', path)
    .select('path')
    .executeTakeFirst()
  if (row !== undefined) {
    return true
  }
  return noteExists(path)
}

/**
 * Far beyond any real graph's same-slug population; hitting it means the
 * probe is lying (e.g. always-true), and failing loud beats spinning.
 */
const MAX_COLLISION_PROBES = 1000

/**
 * The first available `notes/…` path for `slug`: the bare slug, then `-2`,
 * `-3`, …. `taken` is injectable for tests; the default probes the index and
 * the filesystem.
 */
export async function availableNotePath(
  slug: string,
  taken: (path: string) => Promise<boolean> = pathTaken,
): Promise<string> {
  for (let ordinal = 1; ordinal <= MAX_COLLISION_PROBES; ordinal += 1) {
    const candidate = notePath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
    if (!(await taken(candidate))) {
      return candidate
    }
  }
  throw new Error(`no available note path for slug "${slug}" after ${MAX_COLLISION_PROBES} probes`)
}
