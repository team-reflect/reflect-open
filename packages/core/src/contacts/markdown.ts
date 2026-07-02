import { appendBlock } from '../markdown/edit'
import { splitFrontmatter } from '../markdown/frontmatter'
import type { ContactMatch } from './commands'

/**
 * What the suggested-contact card's **Add** writes: the contact's details as
 * plain markdown bullets, owned by the graph from that moment on. Nothing
 * links back to the address book — later corrections happen in the note,
 * exactly like any other markdown.
 *
 * The block follows v1's person template (and the meeting flow's convention):
 * a `- Type: #person` line typing the note for the All Notes person filter,
 * then every email and phone. Suppression after Add is content-based, like
 * v1: {@link noteHasContactDetails} hides the card once details exist, so no
 * frontmatter mark is needed and Add is a single write.
 */

/** Case-insensitive dedup that keeps first occurrence and original casing. */
function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = trimmed.toLowerCase()
    if (trimmed === '' || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

/** A `- Type:` typing bullet (any list marker, any case). */
const TYPE_LINE_PATTERN = /^[ \t]*[-+*][ \t]+type:/im

/**
 * The details block for `contact`: the `- Type: #person` typing line, then
 * every email and phone as bullets (deduped, address-book order — primary
 * values come first). A contact with no email and no phone yields the empty
 * string: there is nothing to add, so the card should not offer Add.
 *
 * Pass the target note's `existingBody` to omit the typing line when the
 * note already carries a `Type:` bullet — a person note born from the
 * meeting flow or the link menu is typed at creation, and Add must not
 * stack a second line.
 */
export function contactDetailsMarkdown(contact: ContactMatch, existingBody = ''): string {
  const emails = uniqueValues(contact.emails)
  const phones = uniqueValues(contact.phones)
  if (emails.length === 0 && phones.length === 0) {
    return ''
  }
  const alreadyTyped = TYPE_LINE_PATTERN.test(existingBody)
  return [
    ...(alreadyTyped ? [] : ['- Type: #person']),
    ...emails.map((email) => `- Email: ${email}`),
    ...phones.map((phone) => `- Phone: ${phone}`),
  ].join('\n')
}

/**
 * Append `contact`'s details block to a note's source via {@link appendBlock}
 * (own paragraph, blank-line separated — the block form the meowdown
 * serializer normalizes to), omitting the typing line when the body already
 * carries one. A contact with no details returns the source unchanged.
 */
export function appendContactDetails(source: string, contact: ContactMatch): string {
  const details = contactDetailsMarkdown(contact, splitFrontmatter(source).body)
  if (details === '') {
    return source
  }
  return appendBlock(source, details)
}

/** An email address anywhere in the body. */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/
/** A `- Email:` / `- Phone:` field bullet (any list marker, any case). */
const FIELD_LINE_PATTERN = /^[ \t]*[-+*][ \t]+(?:email|phone):/im

/**
 * Does the note body already carry contact details — an email address, or an
 * `Email:`/`Phone:` field bullet? v1's suppression rule: such a note gets no
 * suggested-contact card, whether the details came from Add or were typed by
 * hand. Self-healing by construction — delete the details and the card may
 * return. Run this on the **body** (frontmatter split off), not the full
 * source.
 */
export function noteHasContactDetails(body: string): boolean {
  return EMAIL_PATTERN.test(body) || FIELD_LINE_PATTERN.test(body)
}
