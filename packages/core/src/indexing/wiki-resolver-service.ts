import { normalizeWikiTarget, resolved, unresolved, type Resolution } from '../markdown/index.ts'
import type { DatabaseService } from './database-service.ts'
import { verifyWikiSuggestionAddresses } from './queries-shared.ts'
import { rankWikiSuggestions, type WikiLinkSuggestion } from './suggest.ts'

/**
 * The winning tier's claimants for a folded key, preserving ambiguity.
 */
export interface WikiTargetMatch {
  /**
   * One of `CLAIM_TIER`, or {@link UNCLAIMED_TIER} with no paths.
   */
  readonly tier: number
  readonly paths: readonly string[]
}

/**
 * `WikiTargetMatch.tier` when nothing claims the key (never stored).
 */
export const UNCLAIMED_TIER = 0

export interface WikiResolverServiceDeps {
  readonly database: DatabaseService
}

/**
 * Wiki-target resolution over the index's `note_claims` / `note_keys`
 * projection: the one shared resolver, so navigation and backlinks cannot
 * drift onto different claimants.
 */
export interface WikiResolverService {
  /**
   * Resolve a `[[target]]` against the index, returning the note ref (its
   * path). `note_keys` is the canonical resolved-address map: it contains
   * exactly one winning path per folded textual key after applying
   * daily-date, title, alias, and path precedence.
   */
  resolveWikiTarget(target: string): Promise<Resolution>
  /**
   * Look up one folded spelling. `note_claims` already encodes the
   * precedence (templates claim nothing), so this is a single indexed read
   * rather than one query per tier. Unlike {@link resolveWikiTarget}, this
   * does not collapse a tier to its first path; callers that may create on a
   * miss need to distinguish one existing note from several notes claiming
   * the same spelling.
   */
  findWikiTargetMatch(key: string): Promise<WikiTargetMatch>
  /**
   * Every indexed note whose folded path matches, sorted.
   */
  findNotesByPathKey(pathKey: string): Promise<string[]>
  /**
   * Distinct source paths of links whose folded target key is `targetKey`.
   */
  getLinkSources(targetKey: string): Promise<string[]>
  /**
   * Distinct source paths of links that name a file by folded vault path.
   */
  getPathLinkSources(targetPathKey: string): Promise<string[]>
  /**
   * Return a verified wiki-link suggestion for one indexed note path. This is
   * the path-first counterpart to text search: it uses the same canonical
   * title, `note_keys` winner checks, rich-title address, and alias rescue.
   */
  getWikiAddressForPath(path: string): Promise<WikiLinkSuggestion | null>
}

class WikiResolverServiceImpl implements WikiResolverService {
  readonly #deps: WikiResolverServiceDeps

  constructor(deps: WikiResolverServiceDeps) {
    this.#deps = deps
  }

  async resolveWikiTarget(target: string): Promise<Resolution> {
    const normalized = normalizeWikiTarget(target)
    if (normalized.key === '') {
      return unresolved(normalized.raw)
    }
    const path = await this.#deps.database.read('index_resolve_wiki', { key: normalized.key })
    return path === null || path === '' ? unresolved(normalized.raw) : resolved(path)
  }

  async findWikiTargetMatch(key: string): Promise<WikiTargetMatch> {
    if (key === '') {
      return { tier: UNCLAIMED_TIER, paths: [] }
    }
    const match = await this.#deps.database.read('index_wiki_target_match', { key })
    return match ?? { tier: UNCLAIMED_TIER, paths: [] }
  }

  async findNotesByPathKey(pathKey: string): Promise<string[]> {
    if (pathKey === '') {
      return []
    }
    return await this.#deps.database.read('index_notes_by_path_key', { pathKey })
  }

  async getLinkSources(targetKey: string): Promise<string[]> {
    return await this.#deps.database.read('index_link_sources', { targetKey })
  }

  async getPathLinkSources(targetPathKey: string): Promise<string[]> {
    return await this.#deps.database.read('index_path_link_sources', { targetPathKey })
  }

  async getWikiAddressForPath(path: string): Promise<WikiLinkSuggestion | null> {
    const { database } = this.#deps
    const note = await database.read('index_wiki_address_note', { path })
    if (note === null) {
      return null
    }
    const candidate = rankWikiSuggestions('', [note], [], 1)[0]
    if (candidate === undefined) {
      return null
    }
    const result = await verifyWikiSuggestionAddresses(
      database.db,
      [candidate],
      [note.titleKey],
      1,
      '',
      false,
    )
    return result.suggestions[0] ?? null
  }
}

export function createWikiResolverService(deps: WikiResolverServiceDeps): WikiResolverService {
  return new WikiResolverServiceImpl(deps)
}
