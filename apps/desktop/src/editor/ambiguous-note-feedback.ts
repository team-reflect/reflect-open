import { startOperation } from '@/lib/operations'

/**
 * The one user-visible refusal for an `ambiguous` title resolution
 * (`resolveOrCreateNoteWithTitle`): several notes claim the title's fallback
 * key, so neither navigation nor creation can safely pick one. Autocomplete
 * is the disambiguator — its rows carry the distinct titles.
 */
export function reportAmbiguousNoteTitle(operationLabel: string, title: string): void {
  startOperation(operationLabel).fail(
    `Couldn’t safely choose one note matching “${title}”. Choose the intended note from autocomplete.`,
  )
}
