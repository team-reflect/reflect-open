import type { ContactMatch } from './commands.ts'

/**
 * Attendee resolution for the calendar flow (see
 * docs/porting/calendar-meetings-integration.md): a meeting attendee's email
 * is looked up in Apple Contacts so the created person note can be pre-filled.
 * Exported ahead of that flow shipping — the suggested-contact card and the
 * meeting flow share this policy.
 */

/** Normalize an email for comparison: trimmed, lowercased. */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The candidate that actually carries `email` (exact, case-insensitive), or
 * null. The framework's email predicate can return near matches; person notes
 * must only be pre-filled from a contact that verifiably owns the address.
 * Among several owners (shared address-book entries), the named one wins.
 */
export function pickContactForEmail(
  email: string,
  candidates: readonly ContactMatch[],
): ContactMatch | null {
  const wanted = normalizeEmail(email)
  if (wanted === '') {
    return null
  }
  const owners = candidates.filter((candidate) => {
    return candidate.emails.some((candidateEmail) => normalizeEmail(candidateEmail) === wanted)
  })
  if (owners.length === 0) {
    return null
  }
  return owners.find((owner) => owner.fullName.trim() !== '') ?? owners[0] ?? null
}
