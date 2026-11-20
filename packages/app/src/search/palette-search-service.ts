import {
  dateFromDailyPath,
  parseSearchQuery,
  updatedPresetFilter,
  type ClockService,
  type DateSuggestionContext,
  type RetrievalService,
  type SearchService,
  type SuggestionService,
  type UpdatedFilter,
  type UpdatedPreset,
  type WikiSuggestion,
} from '@reflect/core'
import type { Command, CommandService } from '../commands/command-service.ts'
import { buildPaletteSections, type PaletteHit, type PaletteSections } from './palette-entries.ts'

/**
 * What {@link PaletteSearchService.sections} merges.
 */
export interface PaletteSectionsInput {
  /**
   * The live query, as typed.
   */
  query: string
  /**
   * The query the data arrays actually answer (the deferred value).
   */
  dataQuery: string
  suggestions: WikiSuggestion[]
  /**
   * The one search path's results (filters may be empty — Plan 08b).
   */
  hits: PaletteHit[]
  /**
   * True when the data query carried filter tokens (describes `hits`).
   */
  filtered: boolean
}

/**
 * The command palette's data layer (Plan 08): the two index reads (title
 * suggestions + the one search path, whose filters may be empty) and the
 * merge into the sectioned result model. Query deferral, caching and the
 * settled/failed accounting stay with the caller. The pure rules live in
 * `palette-entries.ts`; the mobile All tab's query model in
 * `all-notes-filters.ts`.
 */
export interface PaletteSearchService {
  /**
   * Title suggestions for `text` (at most 8), generated date phrases merged in.
   */
  suggestTitles(text: string, dateContext: DateSuggestionContext): Promise<WikiSuggestion[]>
  /**
   * The search hits for `text`. Filter tokens (#tag, is:daily, is:pinned,
   * links:, linked-from:, updated:) switch the search into constrained mode
   * (Plan 08b); plain text is the same query with empty filters. With
   * `hybrid`, plain text blends semantic hits via RRF; filtered queries stay
   * constraint-based — filters are exact by nature.
   */
  search(text: string, options: { hybrid: boolean }): Promise<PaletteHit[]>
  /**
   * Merge the data with every registered command into the palette's sections.
   */
  sections(input: PaletteSectionsInput): PaletteSections<Command>
  /**
   * Resolve a relative updated-at preset of the mobile All tab against the clock.
   */
  updatedPresetFilter(preset: UpdatedPreset): UpdatedFilter
}

export interface PaletteSearchServiceDeps {
  readonly suggestions: SuggestionService
  readonly search: SearchService
  readonly retrieval: RetrievalService
  readonly commands: CommandService
  readonly clock: ClockService
}

class PaletteSearchServiceImpl implements PaletteSearchService {
  readonly #deps: PaletteSearchServiceDeps

  constructor(deps: PaletteSearchServiceDeps) {
    this.#deps = deps
  }

  async suggestTitles(text: string, dateContext: DateSuggestionContext): Promise<WikiSuggestion[]> {
    return await this.#deps.suggestions.suggestWikiTargets(text, 8, dateContext)
  }

  async search(text: string, options: { hybrid: boolean }): Promise<PaletteHit[]> {
    const { search, retrieval } = this.#deps
    const parsed = parseSearchQuery(text)
    if (!options.hybrid || parsed.filtered) {
      return await search.searchWithFilters(parsed)
    }
    // Adapt RetrievalHit → PaletteHit: semantic chunk text rides in
    // the snippet slot, and the path stands in for the dailyDate the
    // retrieval contract doesn't carry.
    const hits = await retrieval.retrieve(text, { mode: 'hybrid' })
    return hits.map((hit) => ({
      path: hit.path,
      title: hit.title,
      dailyDate: dateFromDailyPath(hit.path),
      snippet: hit.snippet === '' ? null : hit.snippet,
    }))
  }

  sections(input: PaletteSectionsInput): PaletteSections<Command> {
    return buildPaletteSections({ ...input, commands: this.#deps.commands.list() })
  }

  updatedPresetFilter(preset: UpdatedPreset): UpdatedFilter {
    return updatedPresetFilter(preset, new Date(this.#deps.clock.now()))
  }
}

export function createPaletteSearchService(deps: PaletteSearchServiceDeps): PaletteSearchService {
  return new PaletteSearchServiceImpl(deps)
}
