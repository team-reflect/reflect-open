import type { MaybePromise } from '@reflect/utils'
import {
  createContactsService,
  lookupContactPeople,
  type ContactsService,
  type ContactsState,
} from '../contacts/contacts-service.ts'
import type { Unlisten } from '../unlisten.ts'
import {
  isContactsReadable,
  type ContactMatch,
  type ContactsAuthorization,
} from '../contacts/commands.ts'
import type { Settings } from '../settings/schema.ts'
import { createTestIpcBridgeService } from './ipc.ts'
import { createTestLoggerService } from './logger.ts'

export interface TestContactsServiceOptions {
  /**
   * The permission state. Defaults to `authorized`.
   */
  status?: ContactsAuthorization
  /**
   * Whether the permission prompt grants access. Defaults to `true`.
   */
  grantAccess?: boolean
  contacts?: readonly ContactMatch[]
}

export type ContactsLookup =
  | { readonly kind: 'email'; readonly email: string }
  | { readonly kind: 'name'; readonly name: string }

export interface TestContactsService extends ContactsService {
  /**
   * Set the permission state in the OS, and resolve once the app has read it.
   */
  setStatus(status: ContactsAuthorization): Promise<void>
  setContacts(contacts: readonly ContactMatch[]): void
  /**
   * How many times `requestAccess` ran.
   */
  accessRequests(): number
  lookups(): readonly ContactsLookup[]
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
}

class TestContactsServiceImpl implements TestContactsService {
  readonly #inner: ContactsService
  readonly #log: ContactsLookup[] = []
  #status: ContactsAuthorization
  #contacts: ContactMatch[]
  #requests = 0
  readonly get: () => ContactsState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(options?: TestContactsServiceOptions) {
    this.#status = options?.status ?? 'authorized'
    this.#contacts = [...(options?.contacts ?? [])]
    const grantAccess = options?.grantAccess ?? true
    const ipc = createTestIpcBridgeService({
      commands: {
        contacts_authorization_status: () => this.#status,
        contacts_request_access: () => {
          this.#requests++
          if (this.#status === 'notDetermined') {
            this.#status = grantAccess ? 'authorized' : 'denied'
          }
          return isContactsReadable(this.#status)
        },
      },
    })
    this.#inner = createContactsService({ ipc, logger: createTestLoggerService() })
    this.get = this.#inner.get
    this.subscribe = this.#inner.subscribe
    void this.#inner.refresh()
  }

  refresh(): MaybePromise<void> {
    return this.#inner.refresh()
  }

  requestAccess(): MaybePromise<boolean> {
    return this.#inner.requestAccess()
  }

  canLookup(settings: Pick<Settings, 'contactsEnabled'>): boolean {
    return this.#inner.canLookup(settings)
  }

  lookupPeople(query: string): Promise<ContactMatch[]> {
    return lookupContactPeople(query, (name) => this.lookupByName(name))
  }

  lookupByEmail(email: string): Promise<ContactMatch[]> {
    this.#log.push({ kind: 'email', email })
    const wanted = email.toLowerCase()
    return Promise.resolve(
      this.#contacts.filter((contact) => {
        return contact.emails.some((address) => address.toLowerCase() === wanted)
      }),
    )
  }

  lookupByName(name: string): Promise<ContactMatch[]> {
    this.#log.push({ kind: 'name', name })
    const query = words(name)
    return Promise.resolve(
      this.#contacts.filter((contact) => {
        const names = words(`${contact.fullName} ${contact.givenName} ${contact.familyName}`)
        return (
          query.length > 0 && query.every((part) => names.some((word) => word.startsWith(part)))
        )
      }),
    )
  }

  async setStatus(next: ContactsAuthorization): Promise<void> {
    this.#status = next
    await this.#inner.refresh()
  }

  setContacts(next: readonly ContactMatch[]): void {
    this.#contacts = [...next]
  }

  accessRequests(): number {
    return this.#requests
  }

  lookups(): readonly ContactsLookup[] {
    return [...this.#log]
  }
}

/**
 * The real {@link ContactsService} over an in-memory permission and a fixed
 * address book. It reads `status` on creation, so `get` answers `null` until
 * that read lands.
 * `lookupByEmail` matches an address case-insensitively; `lookupByName`
 * matches when every query word is a prefix of a word in a contact's names.
 * Like the OS, `requestAccess` prompts only while the status is
 * `notDetermined`.
 */
export function createTestContactsService(
  options?: TestContactsServiceOptions,
): TestContactsService {
  return new TestContactsServiceImpl(options)
}
