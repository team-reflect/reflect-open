import {
  aliasHint,
  ambiguousNoteTitleMessage,
  contactDetailsMarkdown,
  displayNoteTitle,
  errorMessage,
  formatDayLabel,
  localIsoDate,
  type ClockService,
  type ContactMatch,
  type ContactsService,
  type GraphSessionService,
  type LoggerService,
  type NoteCreationService,
  type PersonContactResolution,
  type PersonNoteService,
  type SettingsService,
  type SuggestionService,
} from '@reflect/core'
import type { OperationsService } from '../app/operations-service.ts'
import { Counter, isNotNullish } from '@ocavue/utils'
import { buildAutocompleteEntries } from './wiki-autocomplete-entries.ts'

/**
 * One row of the editor's `[[` menu. The rows arrive ranked; the menu does not re-sort.
 */
export interface WikiLinkMenuItem {
  /**
   * Inserted as `[[target]]`.
   */
  target: string
  label: string
  /**
   * Secondary text shown beside the label.
   */
  detail?: string
  /**
   * Runs after the menu inserted the link, e.g. to create the note in the background.
   */
  onSelect?: () => void
}

/**
 * One row of the editor's `#` menu.
 */
export interface TagMenuItem {
  /**
   * Inserted as `#tag `.
   */
  tag: string
}

/**
 * The editor's `[[` and `#` autocomplete, shared by every note editor (the
 * note pane and the Tasks view's inline editor). The menu UI hands over the
 * raw text typed after `[[` (case preserved, spaces and slashes intact — only
 * `[`, `]`, and newlines close the menu); ranking stays the index's job, so
 * neither menu re-sorts the rows.
 */
export interface AutocompleteSuggestionService {
  /**
   * The `[[` menu rows for `query`: ranked note suggestions, Contact rows, and
   * a trailing `Create "<query>"` row when nothing matches the typed text.
   * No rows with no graph open. A row's background create writes into the
   * graph open when the rows were asked for, and fails after a switch.
   */
  suggestLinks(query: string): Promise<WikiLinkMenuItem[]>
  /**
   * The `#` menu rows for `query`, most-used first.
   */
  suggestTags(query: string): Promise<TagMenuItem[]>
}

export interface AutocompleteSuggestionServiceDeps {
  readonly suggestions: SuggestionService
  readonly noteCreation: NoteCreationService
  readonly contacts: ContactsService
  readonly personNotes: PersonNoteService
  readonly settings: SettingsService
  readonly clock: ClockService
  readonly operations: OperationsService
  readonly logger: LoggerService
  readonly graphSession: GraphSessionService
}

class AutocompleteSuggestionServiceImpl implements AutocompleteSuggestionService {
  readonly #deps: AutocompleteSuggestionServiceDeps

  constructor(deps: AutocompleteSuggestionServiceDeps) {
    this.#deps = deps
  }

  async suggestLinks(query: string): Promise<WikiLinkMenuItem[]> {
    const { suggestions, contacts, settings, clock, operations, logger, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null) {
      return []
    }
    const { generation } = session
    const current = settings.get()
    const { dateFormat, weekStartDay } = current
    // Contacts join the menu (v1's backlink-menu behavior) only while the
    // integration is on and the permission readable.
    const contactsInMenu = contacts.canLookup(current)
    const dateContext = {
      today: localIsoDate(new Date(clock.now())),
      dateFormat,
      weekStartDay,
    }
    const [wikiLinks, contactResolutions] = await Promise.all([
      suggestions.suggestWikiLinkTargets(query, 8, dateContext),
      contactsInMenu
        ? this.#suggestContacts(query)
        : Promise.resolve<PersonContactResolution[]>([]),
    ])
    const contactCandidates = contactResolutions
      .map((resolution) =>
        resolution.kind === 'blocked'
          ? null
          : {
              contact: resolution.contact,
              target: resolution.insertText,
              ownerPath: resolution.kind === 'existing' ? resolution.path : null,
            },
      )
      .filter(isNotNullish)
    const blockedContactNames = contactResolutions
      .map((resolution) => (resolution.kind === 'blocked' ? resolution.contact.fullName : null))
      .filter(isNotNullish)
    const entries = buildAutocompleteEntries(query, wikiLinks.suggestions, {
      offerCreate: true,
      contacts: contactCandidates,
      blockedContactNames,
      requireSerializableWikiText: true,
      queryReadsAsDate: wikiLinks.queryReadsAsDate,
      claimedTargetKeys: wikiLinks.claimedTargetKeys,
    })
    // Distinct notes can share a title; their rows need the path to tell them apart.
    const titleCounts = new Counter<string>()
    for (const entry of entries) {
      if (entry.kind === 'suggestion' && entry.suggestion.date === null) {
        titleCounts.increment(displayNoteTitle(entry.suggestion.title))
      }
    }
    return entries.map((entry): WikiLinkMenuItem => {
      if (entry.kind === 'create') {
        return {
          target: entry.title,
          label: `Create “${entry.title}”`,
          // Insert happens in the menu; create the note in the background.
          // Best-effort: a failed create just leaves an unresolved link.
          onSelect: () => {
            void this.#resolveOrCreateFromAutocomplete(entry.title, generation).catch(
              (error: unknown) => {
                logger.error('create-from-autocomplete failed:', error)
                operations.fail('Creating note', errorMessage(error))
              },
            )
          },
        }
      }
      if (entry.kind === 'contact') {
        const { contact } = entry
        return {
          target: entry.target,
          label: contact.fullName,
          detail: contact.emails[0] ?? contact.phones[0] ?? 'Contact',
          onSelect: () => void this.#createPersonNote(contact, generation),
        }
      }
      const { title, date, path, generated, insertText: target } = entry.suggestion
      // A generated date leads with its phrase ("Next Friday"), resolved day
      // as the detail; everything else keeps the title/alias/daily form.
      if (generated !== undefined && date !== null) {
        return {
          target,
          label: generated.phrase,
          detail: formatDayLabel(date, dateFormat),
        }
      }
      // A rich title reads as its rendered form; the raw form stays the identity.
      const displayedTitle = displayNoteTitle(title)
      const label = date !== null ? formatDayLabel(date, dateFormat) : displayedTitle
      const shownAlias = aliasHint(entry.suggestion)
      const detail =
        shownAlias !== null
          ? `${shownAlias} → ${displayedTitle}`
          : date !== null
            ? path === null
              ? `${date} · new`
              : date
            : path !== null && titleCounts.get(displayedTitle) > 1
              ? path
              : undefined
      return { target, label, ...(detail !== undefined ? { detail } : {}) }
    })
  }

  async suggestTags(query: string): Promise<TagMenuItem[]> {
    const tags = await this.#deps.suggestions.suggestTags(query)
    return tags.map((tag) => ({ tag: tag.tag }))
  }

  /**
   * The contact rows of the `[[` menu, each resolved against its person note.
   * A contacts hiccup (permission revoked mid-session, store error) costs
   * only these rows, never the note suggestions, so a failure is logged and
   * answers no contacts.
   */
  async #suggestContacts(query: string): Promise<PersonContactResolution[]> {
    const { contacts, personNotes, logger } = this.#deps
    try {
      const matches = await contacts.lookupPeople(query)
      return await Promise.all(
        matches.map(async (contact) => await personNotes.resolvePersonContact(contact)),
      )
    } catch (error: unknown) {
      logger.error('contact link suggestions failed:', error)
      return []
    }
  }

  async #createPersonNote(contact: ContactMatch, generation: number): Promise<void> {
    const { personNotes, logger, operations } = this.#deps
    try {
      const outcome = await personNotes.ensurePersonNote({
        title: contact.fullName,
        emails: contact.emails,
        body: contactDetailsMarkdown(contact),
        generation,
      })
      if (outcome.kind === 'ambiguous') {
        this.#reportAmbiguousNoteTitle(contact.fullName)
      } else if (outcome.kind === 'unavailable') {
        this.#reportUnavailableNoteTitle(contact.fullName)
      }
    } catch (error: unknown) {
      logger.error('create-person-note failed:', error)
      operations.fail('Creating note', errorMessage(error))
    }
  }

  /**
   * The one user-visible refusal for an `ambiguous` title resolution: several
   * notes may claim the title's exact or fallback key, or an unavailable
   * collision prevents proving uniqueness. Creation may not guess then.
   */
  #reportAmbiguousNoteTitle(title: string): void {
    this.#deps.operations.fail('Creating note', ambiguousNoteTitleMessage(title))
  }

  #reportUnavailableNoteTitle(title: string): void {
    this.#deps.operations.fail(
      'Creating note',
      `Couldn’t create “${title}” while a potentially matching note is unavailable. Try again when it is available on this device.`,
    )
  }

  // The `[[` autocomplete's create row: re-resolve and inspect the title's
  // on-disk slug family before creating. The menu inserts the link text either
  // way; an ambiguous, unavailable, or failed create leaves it unresolved.
  async #resolveOrCreateFromAutocomplete(title: string, generation: number): Promise<void> {
    const outcome = await this.#deps.noteCreation.resolveOrCreateNoteWithTitle(title, generation)
    if (outcome.kind === 'ambiguous') {
      this.#reportAmbiguousNoteTitle(title)
    } else if (outcome.kind === 'unavailable') {
      this.#reportUnavailableNoteTitle(title)
    }
  }
}

export function createAutocompleteSuggestionService(
  deps: AutocompleteSuggestionServiceDeps,
): AutocompleteSuggestionService {
  return new AutocompleteSuggestionServiceImpl(deps)
}
