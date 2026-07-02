import { z } from 'zod'
import { call } from '../ipc/invoke'

/**
 * Typed bindings for the Rust `contacts` capability: live Apple Contacts
 * (`CNContactStore`) reads. Lookups are on-demand queries — the address book
 * is never mirrored into the index, and nothing here writes back to Contacts.
 * Matching policy (which titles count as a person, which candidate wins)
 * lives in the sibling modules, not in Rust.
 */

/**
 * The Contacts permission state. `unavailable` is the answer on platforms
 * without the Contacts framework (Windows, Linux, Android) so the settings UI
 * can hide the integration instead of branching on error kinds.
 */
export const contactsAuthorizationSchema = z.enum([
  'notDetermined',
  'restricted',
  'denied',
  'authorized',
  'limited',
  'unavailable',
])

export type ContactsAuthorization = z.infer<typeof contactsAuthorizationSchema>

/** Can lookups be issued right now? `limited` (iOS 18+) still reads the shared subset. */
export function isContactsReadable(status: ContactsAuthorization): boolean {
  return status === 'authorized' || status === 'limited'
}

/**
 * One matched contact, flattened to the fields Reflect can write into a note.
 * Field-level `.catch` keeps a single odd contact from failing a whole lookup.
 */
export const contactMatchSchema = z.object({
  /** Locale-aware display name (given/family ordering differs by locale). */
  fullName: z.string().catch(''),
  givenName: z.string().catch(''),
  familyName: z.string().catch(''),
  emails: z.array(z.string()).catch([]),
  phones: z.array(z.string()).catch([]),
})

export type ContactMatch = z.infer<typeof contactMatchSchema>

/** The current Contacts permission state. Never prompts. */
export async function contactsAuthorizationStatus(): Promise<ContactsAuthorization> {
  return call('contacts_authorization_status', {}, contactsAuthorizationSchema)
}

/**
 * Trigger the OS contacts permission prompt (a no-op once the user has
 * decided) and report whether access is granted.
 */
export async function requestContactsAccess(): Promise<boolean> {
  return call('contacts_request_access', {}, z.boolean())
}

/** Unified contacts with an email address matching `email`. */
export async function lookupContactsByEmail(email: string): Promise<ContactMatch[]> {
  return call('contacts_lookup_by_email', { email }, z.array(contactMatchSchema))
}

/**
 * Unified contacts matching `name` via the framework's own name matching
 * (case- and diacritic-insensitive, word-prefix based). Callers apply the
 * exact-match policy through `matchContactForTitle`.
 */
export async function lookupContactsByName(name: string): Promise<ContactMatch[]> {
  return call('contacts_lookup_by_name', { name }, z.array(contactMatchSchema))
}
