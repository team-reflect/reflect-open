import { isIsoDate } from '@reflect/utils'
import { dailyPath } from '../graph/paths'
import { foldKey } from '../markdown'
import { db } from './db'

/**
 * Resolve a free-form note target — a deep link's `reflect://note/<target>`
 * argument — to a graph-relative path, or null when nothing matches.
 *
 * The order mirrors the CLI's `<note>` argument, with the frontmatter `id`
 * first because it is the one form that survives renames (the reason ids
 * exist, Plan 17):
 *
 * 1. frontmatter `id` — exact match on `notes.id`;
 * 2. a calendar-valid ISO date — the daily path, whether or not the file
 *    exists yet (dailies are created lazily, same as in-app navigation);
 * 3. an explicit graph-relative path;
 * 4. a title match (case-folded like wiki-link resolution);
 * 5. an alias match (`aliases:` frontmatter or a derived v1 subject alias —
 *    a `//` segment of the title — same folding).
 *
 * Ambiguity (two paths claiming one id after a sync fork, duplicate titles)
 * resolves to the first path alphabetically — the CLI's rule. Private notes
 * resolve like any other: a deep link is local navigation, the same act as
 * clicking the note in-app, not an export surface like the CLI.
 */
export async function resolveNoteTarget(target: string): Promise<string | null> {
  const byId = await db
    .selectFrom('notes')
    .where('id', '=', target)
    .select('path')
    .orderBy('path')
    .executeTakeFirst()
  if (byId !== undefined) {
    return byId.path
  }

  if (isIsoDate(target)) {
    return dailyPath(target)
  }

  const byPath = await db
    .selectFrom('notes')
    .where('path', '=', target)
    .select('path')
    .executeTakeFirst()
  if (byPath !== undefined) {
    return byPath.path
  }

  const key = foldKey(target)
  const byTitle = await db
    .selectFrom('notes')
    .where('titleKey', '=', key)
    .select('path')
    .orderBy('path')
    .executeTakeFirst()
  if (byTitle !== undefined) {
    return byTitle.path
  }

  const byAlias = await db
    .selectFrom('aliases')
    .where('aliasKey', '=', key)
    .select('notePath')
    .orderBy('notePath')
    .executeTakeFirst()
  return byAlias?.notePath ?? null
}
