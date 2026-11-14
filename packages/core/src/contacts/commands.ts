import type { ContactsAuthorization } from '@reflect/types'

export type { ContactMatch, ContactsAuthorization } from '@reflect/types'

/**
 * The `contacts` capability's shapes and the permission policy.
 */

/**
 * Can lookups be issued right now? `limited` (iOS 18+) still reads the shared subset.
 */
export function isContactsReadable(status: ContactsAuthorization): boolean {
  return status === 'authorized' || status === 'limited'
}
