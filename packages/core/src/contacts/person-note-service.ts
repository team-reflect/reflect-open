import type { MaybePromise } from '@reflect/utils'
import type {
  NoteCreationService,
  ResolveOrCreateNoteResult,
} from '../graph/note-creation-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { inClauseChunks } from '../indexing/query-utils.ts'
import { serializeWikiSuggestionAddress } from '../indexing/suggest.ts'
import type { WikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { canonicalEmails } from '../markdown/email-fields.ts'
import type { ContactMatch } from './commands.ts'

const PERSON_TAG_KEY = 'person'

export interface MissingPersonResolution {
  readonly kind: 'missing'
  readonly emails: readonly string[]
}

export interface ExistingPersonResolution {
  readonly kind: 'existing'
  readonly emails: readonly string[]
  readonly path: string
  readonly title: string
  readonly insertText: string
}

export interface BlockedPersonResolution {
  readonly kind: 'blocked'
  readonly emails: readonly string[]
  readonly reason: 'identity-conflict' | 'unaddressable-owner'
}

/**

 * The graph's answer for a set of email identities.

 */
export type PersonResolution =
  | MissingPersonResolution
  | ExistingPersonResolution
  | BlockedPersonResolution

export interface NewPersonContactResolution {
  readonly kind: 'new'
  readonly contact: ContactMatch
  readonly insertText: string
}

export interface ExistingPersonContactResolution extends ExistingPersonResolution {
  readonly contact: ContactMatch
}

export interface BlockedPersonContactResolution {
  readonly kind: 'blocked'
  readonly contact: ContactMatch
  readonly reason: BlockedPersonResolution['reason'] | 'unaddressable-contact'
}

/**

 * A Contact row ready for a wikilink surface, or a reason to hide it.

 */
export type PersonContactResolution =
  | NewPersonContactResolution
  | ExistingPersonContactResolution
  | BlockedPersonContactResolution

export interface EnsurePersonNoteInput {
  readonly title: string
  readonly emails: readonly string[]
  readonly generation: number
  readonly body?: string
}

export type EnsurePersonNoteResult =
  | ExistingPersonResolution
  | BlockedPersonResolution
  | ResolveOrCreateNoteResult

interface PersonOwnerRow {
  readonly path: string
}

/**

 * The mapping from email identities to `#person` notes.

 */
export interface PersonNoteService {
  /**
   * Resolve all supplied emails as one person identity. Primary-email order has
   * no ownership priority: zero unique owner paths is missing, one is reusable,
   * and more than one is a conflict.
   */
  resolvePerson(values: readonly string[]): MaybePromise<PersonResolution>
  /**
   * Resolve one Apple Contact into a selectable new/existing wikilink target.
   * Unsafe new names and unsafe or conflicting owners remain blocked identities,
   * so callers cannot fall through to duplicate creation.
   */
  resolvePersonContact(contact: ContactMatch): MaybePromise<PersonContactResolution>
  /**
   * Recheck email ownership immediately before creating a person note. Existing
   * and blocked identities never create; only a current ownership miss reaches
   * the ordinary title resolver and atomic path claim.
   */
  ensurePersonNote(input: EnsurePersonNoteInput): MaybePromise<EnsurePersonNoteResult>
}

export interface PersonNoteServiceDeps {
  readonly database: DatabaseService
  readonly wikiResolver: WikiResolverService
  readonly noteCreation: NoteCreationService
}

class PersonNoteServiceImpl implements PersonNoteService {
  readonly #deps: PersonNoteServiceDeps

  constructor(deps: PersonNoteServiceDeps) {
    this.#deps = deps
  }

  async resolvePerson(values: readonly string[]): Promise<PersonResolution> {
    const { wikiResolver } = this.#deps
    const emails = canonicalEmails(values)
    if (emails.length === 0) {
      return { kind: 'missing', emails }
    }
    const owners = await this.#personOwners(emails)
    if (owners.length === 0) {
      return { kind: 'missing', emails }
    }
    if (owners.length > 1) {
      return { kind: 'blocked', emails, reason: 'identity-conflict' }
    }
    const owner = owners[0]
    if (owner === undefined) {
      return { kind: 'missing', emails }
    }
    const address = await wikiResolver.getWikiAddressForPath(owner.path)
    if (address === null) {
      return { kind: 'blocked', emails, reason: 'unaddressable-owner' }
    }
    return {
      kind: 'existing',
      emails,
      path: owner.path,
      title: address.title,
      insertText: address.insertText,
    }
  }

  async resolvePersonContact(contact: ContactMatch): Promise<PersonContactResolution> {
    const resolution = await this.resolvePerson(contact.emails)
    if (resolution.kind === 'existing') {
      return { ...resolution, contact }
    }
    if (resolution.kind === 'blocked') {
      return { kind: 'blocked', contact, reason: resolution.reason }
    }
    const insertText = serializeWikiSuggestionAddress(contact.fullName, null)
    if (insertText === null) {
      return { kind: 'blocked', contact, reason: 'unaddressable-contact' }
    }
    return { kind: 'new', contact, insertText }
  }

  async ensurePersonNote(input: EnsurePersonNoteInput): Promise<EnsurePersonNoteResult> {
    const resolution = await this.resolvePerson(input.emails)
    if (resolution.kind !== 'missing') {
      return resolution
    }
    return await this.#deps.noteCreation.resolveOrCreateNoteWithTitle(
      input.title,
      input.generation,
      input.body,
    )
  }

  async #personOwners(emails: readonly string[]): Promise<PersonOwnerRow[]> {
    const { db } = this.#deps.database
    const owners = new Map<string, PersonOwnerRow>()
    for (const chunk of inClauseChunks(emails)) {
      const rows = await db
        .selectFrom('noteEmails')
        .innerJoin('notes', 'notes.path', 'noteEmails.notePath')
        .innerJoin('tags', 'tags.notePath', 'notes.path')
        .where('noteEmails.emailKey', 'in', chunk)
        .where('tags.tagKey', '=', PERSON_TAG_KEY)
        .where('notes.kind', '=', 'note')
        .select('notes.path as path')
        .distinct()
        .orderBy('notes.path')
        .execute()
      for (const row of rows) {
        owners.set(row.path, row)
      }
    }
    return [...owners.values()].sort((left, right) => left.path.localeCompare(right.path))
  }
}

export function createPersonNoteService(deps: PersonNoteServiceDeps): PersonNoteService {
  return new PersonNoteServiceImpl(deps)
}
