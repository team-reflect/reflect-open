import { dailyPath, parseSearchQuery } from '@reflect/core'
import type { AppCommand } from '@/lib/commands/types'
import type { FilteredSearchHit, WikiSuggestion } from '@reflect/core'

/**
 * Pure assembly of the palette's sections (Plan 08): merges title suggestions
 * (exact < prefix < substring, from the index), search hits, and matching
 * commands into the sectioned result model. Factored from the component so the
 * ranking/dedupe/`>`-prefix/filter-mode rules are unit-testable.
 */

export interface NoteEntry {
  path: string
  title: string
  /** Set for daily notes (render the day label). */
  date: string | null
  /** Body snippet with highlight markers (search hits only). */
  snippet: string | null
  /** Human label for a generated date suggestion ("Next Friday"); null otherwise. */
  phrase: string | null
}

export interface PaletteSections {
  /** `>` prefix: the query (sans prefix) filters commands only. */
  commandsOnly: boolean
  notes: NoteEntry[]
  commands: AppCommand[]
}

const NOTE_CAP = 12

function matchesCommand(command: AppCommand, query: string): boolean {
  const haystack = [command.title, ...(command.keywords ?? [])].join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

export function buildPaletteSections(options: {
  query: string
  /** The query the data arrays actually answer (the deferred value). */
  dataQuery: string
  suggestions: WikiSuggestion[]
  /** The one search path's results (filters may be empty — Plan 08b). */
  hits: FilteredSearchHit[]
  /** True when the data query carried filter tokens (describes `hits`). */
  filtered: boolean
  commands: AppCommand[]
}): PaletteSections {
  const { commands, filtered } = options
  const query = options.query.trim()
  // The **live** query decides the palette's mode; the deferred data only
  // fills it. Deciding mode from the deferred value would hold the palette in
  // constrained mode (no command rows, the previous filter's notes) after the
  // user deletes the filter tokens, until deferral catches up.
  const liveFiltered = query !== '' && parseSearchQuery(query).filtered
  // The index queries are keyed on a *deferred* value that can lag the live
  // input. Data answering a different query *kind* (cleared input, or filter
  // tokens just added/removed) must not show — a momentarily empty list beats
  // a momentarily wrong one.
  const dataStale = options.dataQuery.trim() !== query
  const modeStale = filtered !== liveFiltered
  const suggestions = query === '' && dataStale ? [] : options.suggestions
  const hits = (query === '' && dataStale) || (dataStale && modeStale) ? [] : options.hits

  if (query.startsWith('>')) {
    const commandQuery = query.slice(1).trim()
    return {
      commandsOnly: true,
      notes: [],
      commands: commands.filter((command) => matchesCommand(command, commandQuery)),
    }
  }

  if (liveFiltered) {
    // Filter tokens are a search mode: the constraint result IS the list —
    // no title-suggestion merge, no command rows.
    return {
      commandsOnly: false,
      notes: hits.slice(0, NOTE_CAP).map((hit) => ({
        path: hit.path,
        title: hit.title,
        date: hit.dailyDate,
        snippet: hit.snippet,
        phrase: null,
      })),
      commands: [],
    }
  }

  // Title matches lead (they're what jump-to-note wants), search hits fill
  // the rest; one row per note, the stronger (title) form wins.
  const notes: NoteEntry[] = []
  const seen = new Set<string>()
  // Real note matches lead; generated date suggestions (they carry a phrase)
  // trail them. In the global palette your existing notes should outrank
  // "Next Monday" — the opposite of the `[[` menu, where dates lead.
  const orderedSuggestions = [
    ...suggestions.filter((suggestion) => suggestion.phrase === undefined),
    ...suggestions.filter((suggestion) => suggestion.phrase !== undefined),
  ]
  for (const suggestion of orderedSuggestions) {
    // A pathless suggestion is a valid daily whose file doesn't exist yet
    // (the lazy contract) — it must still be jumpable: synthesize its daily
    // path, and routeForPath downstream yields the daily route, where the
    // stream creates the file on first keystroke.
    const path =
      suggestion.path ?? (suggestion.date !== null ? dailyPath(suggestion.date) : null)
    if (path !== null && !seen.has(path)) {
      seen.add(path)
      notes.push({
        path,
        title: suggestion.title,
        date: suggestion.date,
        snippet: null,
        phrase: suggestion.phrase ?? null,
      })
    }
  }
  // The empty palette is the recall feed: body hits never join it.
  const bodyHits = query === '' ? [] : hits
  for (const hit of bodyHits) {
    if (!seen.has(hit.path)) {
      seen.add(hit.path)
      notes.push({
        path: hit.path,
        title: hit.title,
        date: hit.dailyDate,
        snippet: hit.snippet,
        phrase: null,
      })
    }
  }

  return {
    commandsOnly: false,
    notes: notes.slice(0, NOTE_CAP),
    // The empty palette is the recall feed (recent notes only — decided);
    // commands appear once the query matches them.
    commands: query === '' ? [] : commands.filter((command) => matchesCommand(command, query)),
  }
}
