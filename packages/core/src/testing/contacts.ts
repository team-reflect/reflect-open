import {
  contactsCanLookup,
  lookupContactPeople,
  type ContactsService,
  type ContactsState,
} from '../contacts/contacts-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { ContactMatch, ContactsAuthorization } from '../contacts/commands.ts'
import { WritableStore } from '../store.ts'
import type { Settings } from '../settings/schema.ts'

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
   * Set the permission state, as the OS and as already read by the app.
   */
  setStatus(status: ContactsAuthorization): void
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
  readonly #grantAccess: boolean
  readonly #log: ContactsLookup[] = []
  #status: ContactsAuthorization
  #contacts: ContactMatch[]
  #requests = 0
  readonly #state: WritableStore<ContactsState>
  readonly get: () => ContactsState
  readonly subscribe: (listener: VoidFunction) => Unlisten

  constructor(options?: TestContactsServiceOptions) {
    this.#status = options?.status ?? 'authorized'
    this.#contacts = [...(options?.contacts ?? [])]
    this.#grantAccess = options?.grantAccess ?? true
    this.#state = new WritableStore<ContactsState>(
      { authorization: this.#status },
      (a, b) => a.authorization === b.authorization,
    )
    this.get = this.#state.get
    this.subscribe = this.#state.subscribe
  }

  refresh(): Promise<void> {
    return Promise.try(() => {
      this.#adoptStatus()
    })
  }

  requestAccess(): Promise<boolean> {
    return Promise.try(() => {
      this.#requests++
      if (this.#status === 'notDetermined') {
        this.#status = this.#grantAccess ? 'authorized' : 'denied'
      }
      this.#adoptStatus()
      return this.#status === 'authorized' || this.#status === 'limited'
    })
  }

  canLookup(settings: Pick<Settings, 'contactsEnabled'>): boolean {
    return contactsCanLookup(this.#state.get(), settings)
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

  setStatus(next: ContactsAuthorization): void {
    this.#status = next
    this.#adoptStatus()
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

  #adoptStatus(): void {
    this.#state.set({ authorization: this.#status })
  }
}

/**
 * An in-memory {@link ContactsService} over a fixed address book. Its state
 * starts read: `get` answers `status` at once.
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
