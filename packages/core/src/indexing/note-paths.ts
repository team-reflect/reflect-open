import { noteExists } from '../graph/commands'
import { notePath, templatePath } from '../graph/paths'
import { slugForTitle } from '../markdown/slug'
import { db } from './db'

/**
 * Collision-free note-path selection — where a note's file should live for
 * its title. New notes are `notes/<slug>.md`; when that's taken,
 * `<slug>-2.md`, `-3`, … — the numeric suffix is the *entire* collision
 * policy (no id-tails on every filename for the rare clash). A candidate is
 * taken when **either** the index has a row for it or the file exists on
 * disk: the index lags the watcher by a debounce, and an unindexed file must
 * never be clobbered by a new note's slug.
 *
 * The entry points share one probe loop: {@link slugPathForTitle} /
 * {@link templateSlugPathForTitle} for the rename pipeline (the note's own
 * path always counts as free — a note never collides with itself, and never
 * "tightens" to a shorter suffix) and {@link availableTemplatePath} for
 * template creation. Note creation no longer probes here: it claims each
 * candidate atomically through the no-clobber `note_create` command
 * (`createNoteWithTitle`), where disk occupancy is the only authority.
 * See `docs/readable-filenames.md`.
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
 * The one probe loop the entry points share: candidates are the bare slug,
 * then `-2`, `-3`, …; the note's own current path (when given) is always an
 * acceptable answer — a note never collides with itself.
 */
async function probeNotePath(
  slug: string,
  taken: (candidate: string) => Promise<boolean>,
  currentPath: string | null,
  buildPath: (slug: string) => string = notePath,
): Promise<string> {
  for (let ordinal = 1; ordinal <= MAX_COLLISION_PROBES; ordinal += 1) {
    const candidate = buildPath(ordinal === 1 ? slug : `${slug}-${ordinal}`)
    if (candidate === currentPath) {
      return currentPath
    }
    if (!(await taken(candidate))) {
      return candidate
    }
  }
  throw new Error(`no available note path for slug "${slug}" after ${MAX_COLLISION_PROBES} probes`)
}

/**
 * The first available `templates/…` path for `slug` (template creation) —
 * the shared probe and collision suffix, in the templates directory. `taken`
 * is injectable for tests; the default probes the index and the filesystem.
 */
export async function availableTemplatePath(
  slug: string,
  taken: (path: string) => Promise<boolean> = pathTaken,
): Promise<string> {
  return probeNotePath(slug, taken, null, templatePath)
}

/**
 * Where `path`'s template file should live for `title` (the settings rename's
 * target) — {@link slugPathForTitle}'s semantics in the templates directory:
 * the template's own path always counts as free, so a no-op rename never
 * "moves" a file onto a `-2` suffix.
 */
export async function templateSlugPathForTitle(
  path: string,
  title: string,
  taken: (candidate: string) => Promise<boolean> = pathTaken,
): Promise<string> {
  return probeNotePath(slugForTitle(title), taken, path, templatePath)
}

/**
 * Where `path`'s file should live for `title` (the rename pipeline's target,
 * Plan 17): the slug path with a collision suffix — or `path` unchanged when
 * its name already matches, so a note never moves onto (or collides with)
 * itself.
 */
export async function slugPathForTitle(
  path: string,
  title: string,
  taken: (candidate: string) => Promise<boolean> = pathTaken,
): Promise<string> {
  return probeNotePath(slugForTitle(title), taken, path)
}
