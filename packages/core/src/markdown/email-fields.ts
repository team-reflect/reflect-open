/**
 * Contact-field emails — the canonical `- Email: ada@example.com` V2 shape,
 * plus V1's `- Email:` / nested-value shape. The indexer projects these into
 * `note_emails` so an invite email can find the person note that owns it
 * (attendee resolution in the calendar flow).
 *
 * Ownership is deliberately narrow: only an explicit `Email:` field bullet
 * counts. A bare address in prose — a daily note quoting an email, a meeting
 * note pasting a thread — is a mention, not ownership, and must not capture
 * the address.
 */

/**
 * An `Email:` field bullet (or pre-2023 V1 `Emails`), capturing indentation
 * and an optional inline value. A missing colon is accepted only when the
 * label occupies the whole list item.
 */
const EMAIL_FIELD_PATTERN = /^([ \t]*)[-+*][ \t]+emails?[ \t]*(?::[ \t]*(.*))?$/i

/** A nested unordered-list item, capturing indentation and value. */
const LIST_ITEM_PATTERN = /^([ \t]*)[-+*][ \t]+(.*)$/
const LEADING_WHITESPACE_PATTERN = /^[ \t]*/
const MARKDOWN_TAB_WIDTH = 4

/**
 * An address inside a field value (tolerates `mailto:` links and commas —
 * excluding `:` keeps the scheme out of the local part).
 */
const EMAIL_PATTERN = /[^\s@<>(),;:[\]]+@[^\s@<>(),;:[\]]+\.[^\s@<>(),;:[\]]+/g

/**
 * Normalize an email identity for matching. Provider-specific transformations
 * such as removing dots or `+tags` are deliberately not applied.
 */
export function canonicalEmail(email: string): string {
  const trimmed = email.trim()
  const wrapped = trimmed.match(/^(?:[^<>]*)<\s*([^<>]+)\s*>$/)
  const address = (wrapped?.[1] ?? trimmed).replace(/^mailto:/i, '').trim()
  return address.toLowerCase()
}

/** The established indexing name for {@link canonicalEmail}. */
export const foldEmail = canonicalEmail

/** Canonicalize, remove blanks, and deduplicate email identities in order. */
export function canonicalEmails(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const emails: string[] = []
  for (const value of values) {
    const email = canonicalEmail(value)
    if (email === '' || seen.has(email)) {
      continue
    }
    seen.add(email)
    emails.push(email)
  }
  return emails
}

function indentationWidth(whitespace: string): number {
  let width = 0
  for (const character of whitespace) {
    if (character === '\t') {
      width += MARKDOWN_TAB_WIDTH - (width % MARKDOWN_TAB_WIDTH)
    } else {
      width += 1
    }
  }
  return width
}

function appendEmails(value: string, seen: Set<string>, emails: string[]): void {
  for (const match of value.matchAll(EMAIL_PATTERN)) {
    const email = match[0].replace(/\.+$/, '')
    const key = canonicalEmail(email)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    emails.push(email)
  }
}

/**
 * Every email a note body owns via a contact field, in document order and
 * case-insensitively deduplicated (first casing kept). V2 writes the value on
 * the `- Email:` line. V1 wrote an empty parent followed by nested address
 * bullets. Run this on the body, frontmatter split off.
 */
export function extractEmailFields(body: string): string[] {
  const seen = new Set<string>()
  const emails: string[] = []
  let legacyParentIndent: number | null = null

  for (const line of body.split(/\r?\n/)) {
    const field = line.match(EMAIL_FIELD_PATTERN)
    if (field !== null) {
      const inlineValue = field[2] ?? ''
      appendEmails(inlineValue, seen, emails)
      legacyParentIndent = inlineValue.trim() === '' ? indentationWidth(field[1] ?? '') : null
      continue
    }

    if (legacyParentIndent === null || line.trim() === '') {
      continue
    }

    const item = line.match(LIST_ITEM_PATTERN)
    const whitespace = item?.[1] ?? line.match(LEADING_WHITESPACE_PATTERN)?.[0] ?? ''
    if (indentationWidth(whitespace) <= legacyParentIndent) {
      legacyParentIndent = null
      continue
    }
    if (item !== null) {
      appendEmails(item[2] ?? '', seen, emails)
    }
  }
  return emails
}
