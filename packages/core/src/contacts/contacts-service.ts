import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { Settings } from '../settings/schema.ts'
import {
  contactMatchSchema,
  contactsAuthorizationSchema,
  isContactsReadable,
  type ContactMatch,
  type ContactsAuthorization,
} from './commands.ts'
import { pickContactLinkSuggestions } from './match.ts'

export {
  contactMatchSchema,
  contactsAuthorizationSchema,
  type ContactMatch,
  type ContactsAuthorization,
} from './commands.ts'

/**
 * The Rust `contacts` capability: live Apple Contacts (`CNContactStore`)
 * reads. Lookups are on-demand queries: the address book is never mirrored
 * into the index, and nothing here writes back to Contacts. Matching policy
 * lives in the sibling modules, not in Rust.
 */

/**

 * How many contacts {@link ContactsService.lookupPeople} answers at most.

 */
const CONTACT_SUGGESTION_LIMIT = 4

/**

 * What the app last read of the Contacts permission.

 */
export interface ContactsState {
  /**
   * The permission state, or `null` until the first {@link ContactsService.refresh} lands.
   */
  readonly authorization: ContactsAuthorization | null
}

/**

 * Live reads of the OS address book, and the permission state as a store.

 */
export interface ContactsService {
  /**
   * The current {@link ContactsState}; the same object until it changes.
   */
  getState: () => ContactsState
  /**
   * Listen for state changes; returns the unsubscribe.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Re-read the permission state. Never prompts and never rejects: a failed
   * read keeps the last state.
   */
  refresh(): MaybePromise<void>
  /**
   * Trigger the OS contacts permission prompt (a no-op once the user has
   * decided), refresh the state, and report whether access is granted.
   */
  requestAccess(): MaybePromise<boolean>
  /**
   * The contacts gate: the integration is enabled and the permission is readable.
   */
  canLookup(settings: Pick<Settings, 'contactsEnabled'>): boolean
  /**
   * The contacts a person-picker offers for `query`: the framework's
   * word-prefix name matches, ranked and capped. Queries shorter than two
   * characters answer empty, since one letter matches half the address book.
   */
  lookupPeople(query: string): MaybePromise<ContactMatch[]>
  /**
   * Unified contacts with an email address matching `email`.
   */
  lookupByEmail(email: string): MaybePromise<ContactMatch[]>
  /**
   * Unified contacts matching `name` through the framework's own name
   * matching (case- and diacritic-insensitive, word-prefix based).
   */
  lookupByName(name: string): MaybePromise<ContactMatch[]>
}

/**
 * The contacts gate: the integration is enabled and the permission is readable.
 */
export function contactsCanLookup(
  state: ContactsState,
  settings: Pick<Settings, 'contactsEnabled'>,
): boolean {
  const { authorization } = state
  return settings.contactsEnabled && authorization !== null && isContactsReadable(authorization)
}

/**
 * The contacts a person-picker offers for `query`, over a name lookup.
 */
export async function lookupContactPeople(
  query: string,
  lookupByName: (name: string) => Promise<ContactMatch[]>,
): Promise<ContactMatch[]> {
  const trimmed = query.trim()
  if (trimmed.length < 2) {
    return []
  }
  return pickContactLinkSuggestions(await lookupByName(trimmed), CONTACT_SUGGESTION_LIMIT)
}

export interface ContactsServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
}

class ContactsServiceImpl implements ContactsService {
  readonly #deps: ContactsServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: ContactsState = { authorization: null }

  constructor(deps: ContactsServiceDeps) {
    this.#deps = deps
  }

  readonly getState = (): ContactsState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  async refresh(): Promise<void> {
    const { ipc, logger } = this.#deps
    let authorization: ContactsAuthorization
    try {
      authorization = await ipc.call(
        'contacts_authorization_status',
        {},
        contactsAuthorizationSchema,
      )
    } catch (cause) {
      logger.warn('failed to read the contacts permission', cause)
      return
    }
    if (authorization === this.#state.authorization) {
      return
    }
    this.#state = { authorization }
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async requestAccess(): Promise<boolean> {
    try {
      return await this.#deps.ipc.call('contacts_request_access', {}, z.boolean())
    } finally {
      await this.refresh()
    }
  }

  canLookup(settings: Pick<Settings, 'contactsEnabled'>): boolean {
    return contactsCanLookup(this.#state, settings)
  }

  lookupPeople(query: string): Promise<ContactMatch[]> {
    return lookupContactPeople(query, (name) => this.lookupByName(name))
  }

  lookupByEmail(email: string): Promise<ContactMatch[]> {
    return this.#deps.ipc.call('contacts_lookup_by_email', { email }, z.array(contactMatchSchema))
  }

  lookupByName(name: string): Promise<ContactMatch[]> {
    return this.#deps.ipc.call('contacts_lookup_by_name', { name }, z.array(contactMatchSchema))
  }
}

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  return new ContactsServiceImpl(deps)
}
