/**
 * Hand-edited note aliases: the names a note answers to besides its title, as
 * the sidebar lists and edits them. Frontmatter `aliases:` is the editable
 * source; v1 `Title // Alias` segments are listed alongside but stay owned by
 * the H1 (see `subject-aliases.ts`).
 */
import { parseNote } from './extract.ts'
import { foldKey } from './keys.ts'
import { subjectAliases } from './subject-aliases.ts'

/** A note's alternative names, split by where each one is authored. */
export interface NoteAliases {
  /** The note's canonical title, which every alias must differ from. */
  readonly title: string
  /** `aliases:` frontmatter entries, in file order. */
  readonly frontmatter: readonly string[]
  /** The title's `//` segments after the first, which reader surfaces show as the title. */
  readonly fromTitle: readonly string[]
}

/** Why a typed alias was refused. */
export type AliasRejection = 'empty' | 'invalid' | 'duplicate'

// Wiki-link syntax can't round-trip through `[[alias]]`, and `//` would be
// read back as a subject-alias separator.
const FORBIDDEN_ALIAS_TEXT = /[[\]|]|\/\//u

/** Read the title and both alias sources from a note's markdown. */
export function readNoteAliases(path: string, source: string): NoteAliases {
  const parsed = parseNote({ path, source })
  return {
    title: parsed.title,
    frontmatter: parsed.frontmatter.aliases,
    fromTitle: subjectAliases(parsed.title).slice(1),
  }
}

/**
 * Check a typed alias against the note it would join, returning why it can't
 * be added or `null` when it can. A name the note already answers to (title,
 * `//` segment, or existing alias — compared by {@link foldKey}, like link
 * resolution) adds nothing.
 */
export function rejectAlias(candidate: string, aliases: NoteAliases): AliasRejection | null {
  const alias = candidate.trim()
  if (alias === '') {
    return 'empty'
  }
  if (FORBIDDEN_ALIAS_TEXT.test(alias)) {
    return 'invalid'
  }
  const taken = [aliases.title, ...subjectAliases(aliases.title), ...aliases.frontmatter]
  return taken.some((name) => foldKey(name) === foldKey(alias)) ? 'duplicate' : null
}

/** `current` with `alias` appended, trimmed. */
export function withAlias(current: readonly string[], alias: string): string[] {
  return [...current, alias.trim()]
}

/** `current` without `alias`, matched by {@link foldKey}. */
export function withoutAlias(current: readonly string[], alias: string): string[] {
  const key = foldKey(alias)
  return current.filter((entry) => foldKey(entry) !== key)
}
