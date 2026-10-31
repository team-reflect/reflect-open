import type { Database } from '@reflect/db'
import { sql, type Kysely, type RawBuilder } from 'kysely'
import { wikiNoteReference } from '../graph/note-reference.ts'
import { normalizeWikiTarget } from '../markdown/index.ts'
import { inClauseChunks } from './query-utils.ts'
import {
  serializeWikiSuggestionAddress,
  type WikiLinkSuggestion,
  type WikiSuggestion,
} from './suggest.ts'

/** Verified editor rows plus facts that remain true when rows are filtered. */
export interface WikiLinkSuggestionResult {
  readonly suggestions: readonly WikiLinkSuggestion[]
  /**
   * Folded candidate/query keys owned in `note_keys`, including ambiguous or
   * unsafe claims that could not become selectable rows.
   */
  readonly claimedTargetKeys: readonly string[]
  /** Whether the raw query produced at least one generated date candidate. */
  readonly queryReadsAsDate: boolean
}

/**
 * The recall-feed ordering, shared by the filtered search and the All Notes
 * list so the two "V1 list order" implementations can't drift: optionally
 * pinned-first (explicit pin order, then unordered pins), then recency, then
 * path as the stable tiebreaker. Raw fragments because Kysely's typed
 * `orderBy` can't resolve `notes.*` refs across differently-rooted queries.
 */
export function recallOrder(pinnedFirst: boolean): RawBuilder<unknown>[] {
  const pinned = [
    sql`"notes"."is_pinned" desc`,
    sql`"notes"."pinned_order" is null`,
    sql`"notes"."pinned_order"`,
  ]
  return [...(pinnedFirst ? pinned : []), sql`"notes"."mtime" desc`, sql`"notes"."path"`]
}

/**
 * Turn ranked candidates into selectable suggestions using `note_keys` as the
 * authoritative one-winner-per-key address map. Every target must also have
 * exactly one claimant in its winning tier, matching the ambiguity guard that
 * writable navigation applies to date-shaped and ordinary spellings alike.
 * The canonical title is preferred for alias rows; when it is ambiguous or
 * lost, a unique alias can rescue the note. A pathless generated date is
 * reattached to an existing daily even when its custom title kept it out of
 * the search rows. Candidates with no safe textual address are omitted.
 */
interface WikiAddressWinner {
  path: string
  dailyDate: string | null
  claimCount: number
}

function winnerAddressesPath(path: string, winner: WikiAddressWinner | undefined): boolean {
  return winner?.path === path && winner.claimCount === 1
}

/**
 * The verified suggestion for an existing note using only its ranked
 * spellings (canonical target, then the matched alias), or `null` when
 * neither is a safe winning address for `candidate.path`. The display half
 * of `target|display` is cosmetic: when the matched alias cannot ride along
 * in wiki-link syntax (`Dad|Junior`), the bare canonical address still opens
 * the same note, which beats hiding the note from the menu.
 */
function addressableAsRanked(
  candidate: WikiSuggestion,
  winners: ReadonlyMap<string, WikiAddressWinner>,
): WikiLinkSuggestion | null {
  if (candidate.path === null) {
    return null
  }
  const canonicalWinner = winners.get(normalizeWikiTarget(candidate.target).key)
  const canonicalInsert =
    serializeWikiSuggestionAddress(candidate.target, candidate.alias) ??
    serializeWikiSuggestionAddress(candidate.target, null)
  if (winnerAddressesPath(candidate.path, canonicalWinner) && canonicalInsert !== null) {
    return { ...candidate, insertText: canonicalInsert }
  }
  if (candidate.alias !== null) {
    const aliasKey = normalizeWikiTarget(candidate.alias).key
    const aliasInsert = serializeWikiSuggestionAddress(candidate.alias, null)
    if (winnerAddressesPath(candidate.path, winners.get(aliasKey)) && aliasInsert !== null) {
      return { ...candidate, insertText: aliasInsert }
    }
  }
  return null
}

/**
 * For each path, the aliases (declaration order) that safely address the note:
 * the note wins `note_keys` and the alias is uniquely claimed in its winning
 * tier. These rescue notes whose ranked spellings are ambiguous, lost, or
 * cannot be serialized.
 */
async function winningAliasesByPath(
  db: Kysely<Database>,
  paths: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const winning = new Map<string, string[]>()
  for (const chunk of inClauseChunks([...paths])) {
    const rows = await db
      .selectFrom('aliases')
      .innerJoin('noteKeys', (join) => {
        return join
          .onRef('noteKeys.key', '=', 'aliases.aliasKey')
          .onRef('noteKeys.notePath', '=', 'aliases.notePath')
      })
      .where('aliases.notePath', 'in', chunk)
      .select(['aliases.notePath', 'aliases.alias', 'noteKeys.claimCount'])
      .orderBy(sql`"aliases"."rowid"`)
      .execute()
    for (const row of rows) {
      if (Number(row.claimCount) !== 1) {
        continue
      }
      const aliases = winning.get(row.notePath) ?? []
      aliases.push(row.alias)
      winning.set(row.notePath, aliases)
    }
  }
  return winning
}

/**
 * Last resort for a note whose every name is ambiguous or unserializable:
 * address it by its own path. `[[notes/plan-2]]` names exactly one file, so
 * the row stays selectable instead of vanishing, and the link the user writes
 * never needs disambiguating later. A root-level file gains a `/` so the
 * target reads as a path rather than a name.
 *
 * The address is proven by round trip: {@link wikiNoteReference} must reduce
 * the spelling back to exactly this file. A path with no such spelling — a
 * `#` reads as a fragment separator, a loose slash segment reads as a name —
 * stays reachable through search and Markdown hrefs but cannot be inserted
 * from the `[[` menu.
 */
function pathQualifiedInsert(path: string, candidate: WikiSuggestion): string | null {
  const target = path.replace(/\.md$/, '')
  const qualified = target.includes('/') ? target : `/${target}`
  const reduced = wikiNoteReference(qualified)
  if ((reduced?.kind !== 'path' && reduced?.kind !== 'pathOrKey') || reduced.path !== path) {
    return null
  }
  return fallbackInsert(qualified, candidate)
}

/**
 * Serialize a fallback address with the note's ranked spelling as its display
 * text, or bare when that spelling cannot ride along.
 */
function fallbackInsert(address: string, candidate: WikiSuggestion): string | null {
  return (
    serializeWikiSuggestionAddress(address, candidate.alias ?? candidate.target) ??
    serializeWikiSuggestionAddress(address, null)
  )
}

export async function verifyWikiSuggestionAddresses(
  db: Kysely<Database>,
  candidates: readonly WikiSuggestion[],
  candidateTargetKeys: readonly string[],
  limit: number,
  queryKey: string,
  queryReadsAsDate: boolean,
): Promise<WikiLinkSuggestionResult> {
  const keys = new Set(candidateTargetKeys)
  keys.add(queryKey)
  for (const candidate of candidates) {
    keys.add(normalizeWikiTarget(candidate.target).key)
    if (candidate.alias !== null) {
      keys.add(normalizeWikiTarget(candidate.alias).key)
    }
  }
  keys.delete('')

  const winners = new Map<string, WikiAddressWinner>()
  for (const chunk of inClauseChunks([...keys])) {
    const rows = await db
      .selectFrom('noteKeys')
      .innerJoin('notes', 'notes.path', 'noteKeys.notePath')
      .where('key', 'in', chunk)
      .select(['key', 'notePath', 'notes.dailyDate', 'noteKeys.claimCount'])
      .execute()
    for (const row of rows) {
      if (row.key !== null && row.notePath !== null) {
        winners.set(row.key, {
          path: row.notePath,
          dailyDate: row.dailyDate,
          claimCount: Number(row.claimCount),
        })
      }
    }
  }

  const unaddressedPaths = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.path !== null && addressableAsRanked(candidate, winners) === null) {
      unaddressedPaths.add(candidate.path)
    }
  }
  const rescueAliases =
    unaddressedPaths.size > 0
      ? await winningAliasesByPath(db, unaddressedPaths)
      : new Map<string, string[]>()
  const claimedTargetKeys = new Set(winners.keys())
  for (const aliases of rescueAliases.values()) {
    for (const alias of aliases) {
      claimedTargetKeys.add(normalizeWikiTarget(alias).key)
    }
  }

  const verified: WikiLinkSuggestion[] = []
  for (const candidate of candidates) {
    if (candidate.path === null) {
      const canonicalWinner = winners.get(normalizeWikiTarget(candidate.target).key)
      const insertText = serializeWikiSuggestionAddress(candidate.target, candidate.alias)
      if (insertText !== null) {
        if (canonicalWinner === undefined) {
          verified.push({ ...candidate, insertText })
        } else if (
          candidate.date !== null &&
          canonicalWinner.dailyDate === candidate.date &&
          canonicalWinner.claimCount === 1
        ) {
          verified.push({
            ...candidate,
            path: canonicalWinner.path,
            insertText,
          })
        }
      }
    } else {
      const ranked = addressableAsRanked(candidate, winners)
      if (ranked !== null) {
        verified.push(ranked)
      } else {
        let rescued = false
        for (const alias of rescueAliases.get(candidate.path) ?? []) {
          const insertText = fallbackInsert(alias, candidate)
          if (insertText !== null) {
            verified.push({ ...candidate, alias, insertText })
            rescued = true
            break
          }
        }
        if (!rescued) {
          const pathInsert = pathQualifiedInsert(candidate.path, candidate)
          if (pathInsert !== null) {
            verified.push({ ...candidate, insertText: pathInsert })
          }
        }
      }
    }

    if (verified.length >= limit) {
      break
    }
  }
  return {
    suggestions: verified,
    claimedTargetKeys: [...claimedTargetKeys].sort(),
    queryReadsAsDate,
  }
}
