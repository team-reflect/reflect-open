import { z } from 'zod'

/**
 * The `contacts` capability's shapes and the permission policy.
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

/**
 * Can lookups be issued right now? `limited` (iOS 18+) still reads the shared subset.
 */
export function isContactsReadable(status: ContactsAuthorization): boolean {
  return status === 'authorized' || status === 'limited'
}
