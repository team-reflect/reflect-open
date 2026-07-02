import { lookupContactsByName, type ContactMatch } from './commands'

/**
 * The person-note matching rule: a note earns a suggested-contact card only
 * when its title **exactly equals** a contact's full name (case-insensitive,
 * diacritic-insensitive, whitespace-collapsed). Exactness is the
 * false-positive guard the porting doc asks for — a two-word note title like
 * "Meeting Notes" never matches, and no `#person` tag or other opt-in is
 * required.
 */

/**
 * Normalize a name for exact comparison: diacritics folded (NFD, marks
 * stripped), trimmed, collapsed, lowercased. Folding matches the framework's
 * own name predicate, which is diacritic-insensitive — without it a "Rene
 * Descartes" title would *receive* the "René Descartes" candidate and then
 * silently reject it here.
 */
function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * Do two person names count as the same under the matching rule? The
 * `ignoredContacts` dismissal list compares through this, so a dismissal
 * recorded as "Ada Lovelace" also covers a lookup answering "ada lovelace".
 */
export function contactNamesEqual(left: string, right: string): boolean {
  const normalized = normalizeName(left)
  return normalized !== '' && normalized === normalizeName(right)
}

/**
 * The candidate whose full name exactly equals `title`, or null.
 *
 * The framework's name predicate is word-prefix based (searching "Ada" also
 * returns "Ada Lovelace"), so this is where prefix hits are discarded. Among
 * several exact matches (two address-book entries for the same person), the
 * one with the most detail wins — a card offering an email beats an empty one.
 */
export function matchContactForTitle(
  title: string,
  candidates: readonly ContactMatch[],
): ContactMatch | null {
  const wanted = normalizeName(title)
  if (wanted === '') {
    return null
  }
  const exact = candidates.filter(
    (candidate) => normalizeName(candidate.fullName) === wanted,
  )
  if (exact.length === 0) {
    return null
  }
  const detailed = [...exact].sort(
    (left, right) =>
      right.emails.length + right.phones.length - (left.emails.length + left.phones.length),
  )
  return detailed[0] ?? null
}

/**
 * Look up `title` in Apple Contacts and apply the exact-match rule. Returns
 * null for blank titles without touching the bridge. Callers gate on the
 * integration being enabled and readable first (`isContactsReadable`).
 */
export async function suggestContactForTitle(title: string): Promise<ContactMatch | null> {
  if (title.trim() === '') {
    return null
  }
  const candidates = await lookupContactsByName(title.trim())
  return matchContactForTitle(title, candidates)
}
