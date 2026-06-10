import { dailyPath } from '@reflect/core'
import type { AppCommand } from '@/lib/commands/types'
import type { RankedSearchHit, WikiSuggestion } from '@reflect/core'

/**
 * Pure assembly of the palette's sections (Plan 08): merges title suggestions
 * (exact < prefix < substring, from the index), FTS body hits, and matching
 * commands into the sectioned result model. Factored from the component so the
 * ranking/dedupe/`>`-prefix rules are unit-testable.
 */

export interface NoteEntry {
  path: string
  title: string
  /** Set for daily notes (render the day label). */
  date: string | null
  /** Body snippet with highlight markers (FTS hits only). */
  snippet: string | null
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
  suggestions: WikiSuggestion[]
  hits: RankedSearchHit[]
  commands: AppCommand[]
}): PaletteSections {
  const { suggestions, hits, commands } = options
  const query = options.query.trim()

  if (query.startsWith('>')) {
    const commandQuery = query.slice(1).trim()
    return {
      commandsOnly: true,
      notes: [],
      commands: commands.filter((command) => matchesCommand(command, commandQuery)),
    }
  }

  // Title matches lead (they're what jump-to-note wants), FTS body hits fill
  // the rest; one row per note, the stronger (title) form wins.
  const notes: NoteEntry[] = []
  const seen = new Set<string>()
  for (const suggestion of suggestions) {
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
      })
    }
  }
  // The empty palette is the recall feed: suggestions only. The FTS query is
  // keyed on a *deferred* value that can lag a just-cleared input — without
  // this gate the previous search's body hits would leak into the feed.
  const bodyHits = query === '' ? [] : hits
  for (const hit of bodyHits) {
    if (!seen.has(hit.path)) {
      seen.add(hit.path)
      notes.push({ path: hit.path, title: hit.title, date: null, snippet: hit.snippet })
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
