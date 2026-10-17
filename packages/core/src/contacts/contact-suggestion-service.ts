import { requireGraphSession } from '../graph/graph-session.ts'
import type { NoteDocumentService } from '../documents/note-document-service.ts'
import type { OpenDocumentsService } from '../documents/open-documents-service.ts'
import type { GraphSessionService } from '../graph/graph-session-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { isDaily } from '../graph/paths.ts'
import { parseNote } from '../markdown/extract.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import type { Settings } from '../settings/schema.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { ContactMatch, ContactsAuthorization, ContactsService } from './contacts-service.ts'
import { appendContactDetails, contactDetailsMarkdown, noteHasContactDetails } from './markdown.ts'
import { contactNamesEqual, matchContactForTitle } from './match.ts'

/**
 * The suggested-contact card (the contacts-integration port): a note whose
 * title exactly matches an Apple Contact is offered that contact's details.
 * Suppression follows v1's model:
 *
 * - **content**: a body that already carries contact details (an email, an
 *   `Email:`/`Phone:` bullet) gets no card, whether Add wrote them or the
 *   user typed them. This is also what hides the card after Add.
 * - **dismissals**: a contact named in the note's `ignoredContacts`
 *   frontmatter list never re-suggests; other contacts still may.
 *
 * The card's two resolutions: **Add** lands the contact's details in the body
 * as plain markdown, a single write with no frontmatter mark. **Ignore**
 * records the contact's name in `ignoredContacts`, per contact, so a retitled
 * note stays eligible for its own suggestion. Nothing ever syncs back to the
 * address book.
 */
export interface ContactSuggestionService {
  /**
   * The card's gate for the note at `path`: the contacts gate
   * ({@link ContactsService.canLookup}) is open and the note is not a daily one.
   */
  showsSuggestionFor(settings: Pick<Settings, 'contactsEnabled'>, path: string): boolean
  /**
   * The Apple Contact the title of the note at `path` exactly matches, or
   * `null`: no match, a match with nothing to add, a body that already
   * carries contact details, or a contact dismissed on this note. Callers
   * gate on {@link ContactSuggestionService.showsSuggestionFor} first.
   */
  suggestionFor(path: string): Promise<ContactMatch | null>
  /**
   * Merge `contact`'s details into the note: the `- Type: #person` typing line
   * plus every email and phone, appended as their own block. Routes through
   * the live session when the note is open — the card sits above an open
   * editor, so unsaved edits must survive — and refuses rather than clobber
   * when the session can't take it (loading, protected, or disposed).
   * A closed note is patched on disk. Retry-safe: a body that already carries
   * the details is left alone. Throws when the title no longer matches
   * `contact`, or when no graph is open.
   */
  addToNote(path: string, contact: ContactMatch): Promise<void>
  /**
   * Dismiss the suggestion for this note: record `contact`'s name in the
   * `ignoredContacts` frontmatter list, write nothing else. A stale card (the
   * title no longer matches `contact`) skips the write silently — the user
   * wanted the card gone, and the new title must stay eligible for its own
   * suggestion. Throws when no graph is open.
   */
  ignore(path: string, contact: ContactMatch): Promise<void>
  /**
   * Switch the integration on or off. Never prompts.
   */
  setEnabled(enabled: boolean): void
  /**
   * Trigger the OS contacts permission prompt and refresh the permission
   * state. Never rejects: a failed prompt (e.g. it timed out unanswered) isn't
   * surfaced, the permission state is the truth.
   */
  requestAccess(): Promise<void>
}

/**

 * The card's detail line: the contact's primary email and phone.

 */
export function suggestedContactDetails(contact: ContactMatch): string {
  return [contact.emails[0], contact.phones[0]]
    .filter((value): value is string => value !== undefined && value.trim() !== '')
    .join(' · ')
}

/**

 * Does the Contacts framework exist here? `null` is a read still in flight.

 */
export function isContactsAvailable(authorization: ContactsAuthorization | null): boolean {
  return authorization !== null && authorization !== 'unavailable'
}

/**
 * What the settings switch says about the permission while the integration
 * is on:
 *
 * - `denied`: the app cannot re-prompt once the user has decided, so the
 *   notice points at System Settings.
 * - `prompt`: enabled but never asked. The toggle-on prompt didn't complete
 *   (quit mid-prompt, settings restored from another machine), so the notice
 *   offers the prompt again. Suppressed while a prompt is up.
 */
export function contactsAccessNotice(
  settings: Pick<Settings, 'contactsEnabled'>,
  authorization: ContactsAuthorization | null,
  isPrompting: boolean,
): 'denied' | 'prompt' | null {
  if (!settings.contactsEnabled) {
    return null
  }
  if (authorization === 'denied' || authorization === 'restricted') {
    return 'denied'
  }
  return authorization === 'notDetermined' && !isPrompting ? 'prompt' : null
}

/**

 * Only an undecided permission can still show the OS prompt.

 */
export function canPromptForContacts(authorization: ContactsAuthorization | null): boolean {
  return authorization === 'notDetermined'
}

export interface ContactSuggestionServiceDeps {
  readonly contacts: ContactsService
  readonly noteDocuments: NoteDocumentService
  readonly openDocuments: OpenDocumentsService
  readonly noteFile: NoteFileService
  readonly settings: SettingsService
  readonly graphSession: GraphSessionService
  readonly logger: LoggerService
}

class ContactSuggestionServiceImpl implements ContactSuggestionService {
  readonly #deps: ContactSuggestionServiceDeps

  constructor(deps: ContactSuggestionServiceDeps) {
    this.#deps = deps
  }

  showsSuggestionFor(current: Pick<Settings, 'contactsEnabled'>, path: string): boolean {
    return this.#deps.contacts.canLookup(current) && !isDaily(path)
  }

  async suggestionFor(path: string): Promise<ContactMatch | null> {
    const source = await this.#deps.noteDocuments.readSource(path)
    if (noteHasContactDetails(splitFrontmatter(source).body)) {
      return null
    }
    const note = parseNote({ path, source })
    const match = await this.#contactForTitle(note.title)
    // A match with nothing to add (no email, no phone) has no card to offer.
    if (match === null || contactDetailsMarkdown(match) === '') {
      return null
    }
    const dismissed = note.frontmatter.ignoredContacts.some((name) =>
      contactNamesEqual(name, match.fullName),
    )
    return dismissed ? null : match
  }

  async addToNote(path: string, contact: ContactMatch): Promise<void> {
    const { openDocuments, noteFile, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const source = await this.#sourceIfStillMatching(path, contact)
    if (source === null) {
      throw new Error('The note title no longer matches this contact.')
    }
    const body = splitFrontmatter(source).body
    // The same content gate the card renders through: a body that already
    // carries contact details — a previous Add's block, or an email the user
    // typed under a still-cached card — must not get a (second) block. The
    // body-aware block also drops the `- Type: #person` line when the note was
    // already typed at creation (meeting flow, link menu).
    const details = contactDetailsMarkdown(contact, body)
    if (details === '' || noteHasContactDetails(body)) {
      return
    }
    const owner = openDocuments.sessionFor(path)
    if (owner !== null) {
      if (!(await owner.commitBodyAppend(details))) {
        throw new Error('This note can’t be updated right now — try again in a moment.')
      }
      return
    }
    // Reuse the validated snapshot — with no session, `source` came from disk.
    // A second read here would reopen the window between the check and the write.
    await noteFile.write(path, appendContactDetails(source, contact), generation)
  }

  async ignore(path: string, contact: ContactMatch): Promise<void> {
    const { noteDocuments, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    const source = await this.#sourceIfStillMatching(path, contact)
    if (source === null) {
      return
    }
    const ignored = parseNote({ path, source }).frontmatter.ignoredContacts
    if (ignored.some((name) => contactNamesEqual(name, contact.fullName))) {
      return
    }
    await noteDocuments.commitFrontmatter(
      path,
      { ignoredContacts: [...ignored, contact.fullName] },
      generation,
    )
  }

  setEnabled(enabled: boolean): void {
    this.#deps.settings.update({ contactsEnabled: enabled })
  }

  async requestAccess(): Promise<void> {
    try {
      await this.#deps.contacts.requestAccess()
    } catch (error: unknown) {
      // A failed request leaves the access status unchanged.
      this.#deps.logger.warn('requesting contacts access failed:', error)
    }
  }

  /**
   * Action-time revalidation: the card's suggestion is a cached answer, but the
   * title may have been edited (even unsaved) since it resolved. Returns the
   * live source when the note still carries the contact's name, else null —
   * a stale card must neither merge the wrong details nor dismiss the new
   * title's own suggestion.
   */
  async #sourceIfStillMatching(path: string, contact: ContactMatch): Promise<string | null> {
    const source = await this.#deps.noteDocuments.readSource(path)
    const title = parseNote({ path, source }).title
    return matchContactForTitle(title, [contact]) === null ? null : source
  }

  /**
   * Look up `title` in Apple Contacts and apply the exact-match rule. Answers
   * null for blank titles without a lookup.
   */
  async #contactForTitle(title: string): Promise<ContactMatch | null> {
    if (title.trim() === '') {
      return null
    }
    const candidates = await this.#deps.contacts.lookupByName(title.trim())
    return matchContactForTitle(title, candidates)
  }
}

export function createContactSuggestionService(
  deps: ContactSuggestionServiceDeps,
): ContactSuggestionService {
  return new ContactSuggestionServiceImpl(deps)
}
