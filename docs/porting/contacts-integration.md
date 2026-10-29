# Porting contacts integration

**Status: shipped.** In v1, contacts turned meeting attendees and
name-like notes into person notes without manual entry. v2 keeps that role
but reads **Apple Contacts** instead of syncing provider address books
through a server.

Shipped: the Rust `contacts` capability (`CNContactStore` via `objc2`), the
Settings → System integrations switch with the permission flow, the
suggested-contact card, contacts in the `[[` link menu, and the attendee
half of the [calendar flow](./calendar-meetings-integration.md): add-meeting
resolves each attendee email against explicit `Email` fields on `#person`
notes. A unique owner is reused; conflicting or unaddressable owners stay
plain text and never create a duplicate. On a miss, Apple Contacts can
supply the name and details for the new person note.

Decisions taken at implementation time:

- **Person-note matching is exact.** The card appears only when the note
  title equals a contact's full name (case- and diacritic-insensitive,
  whitespace-collapsed, mirroring the framework predicate's folding). No
  `#person` tag is required, and the framework's word-prefix hits are
  discarded (`matchContactForTitle`).
- **No photos.** Add writes a `- Type: #person` line (v1's Type field, same
  as the meeting flow) plus every email and phone as plain bullets. Photos
  (binary → `assets/`) can follow without rework.
- **Suppression is content-based, dismissals per contact (v1's model).** A
  note whose body already has contact details (an email, an
  `Email:`/`Phone:` bullet) gets no card, which also hides the card after
  Add, with no frontmatter mark. Ignore records the contact's name in the
  note's `ignoredContacts` frontmatter list (v1's `ignoredContactNames`),
  so a retitled note stays eligible for its own suggestion and the state
  travels with the note.
- **Contacts join the `[[` link menu, like v1's backlink menu.** Word-prefix
  matches appear after note suggestions. All of a contact's emails resolve
  as one identity: a unique `#person` owner supplies the wikilink address, a
  miss creates a prefilled person note, and several owners block the
  contact row instead of choosing one. An exact blocked contact also
  suppresses its duplicate-creating Create fallback; note suggestions stay.
- **Email ownership is explicit and conservative.** Only `Email` fields on
  `#person` notes count, including legacy V1 nested `Email` / `Emails`
  lists. Values are canonicalized for matching; primary email order does
  not break conflicts.
- **No `mailto:`/`tel:` links.** v1's rich editor hid URLs; in markdown the
  syntax would double every value, and the editor's link opener is scoped
  to `https`. Autolinking can make plain values clickable later.

## What v1 did

- Synced contacts (names, emails, phones, photos) from connected Google,
  Microsoft, or iCloud accounts, with the same credentials as calendar.
- Showed a **Suggested contact** card on notes whose subject looked like a
  person's name, with one action to merge the details into the note.
- Resolved meeting attendees against the contact store so "add meeting to
  daily note" pre-populated person notes.

## Why the v1 approach can't port

Same as calendar: provider contact APIs need OAuth with server-held
secrets. The OS-native replacement, `CNContactStore`, already aggregates
the Google, Exchange, and iCloud contacts added to macOS.

## How it will work in v2

### User experience

1. **Enabling.** A **Contacts** switch in Settings, paired with Calendar in
   one "System integrations" section. It triggers the macOS permission
   prompt; denial shows an inline pointer to System Settings.
2. **Meeting attendees become person notes.** Attendee emails first resolve
   against existing `#person` notes. On a miss, Apple Contacts can pre-fill
   name, email, and phone. Without Contacts, the invite email is still
   written.
3. **Suggested contact.** On a note whose title matches a contact, a card
   offers the details with **Add** (writes them as plain markdown) and
   **Ignore** (dismisses it for that note).
4. **Nothing syncs.** Contact data enters a note only on explicit Add, then
   it is ordinary markdown. Reflect never writes to the address book.

### Architecture

- **Rust owns the capability.** A `contacts` module in
  `apps/desktop/src-tauri/src/` binds the Contacts framework via `objc2`.
  Commands: request access, look up by email, look up by name.
- **Lookups are live queries, not a mirror.** v1 copied the address book
  locally and showed "N contacts" sync status. v2 queries `CNContactStore`
  on demand and persists nothing, so the address book never enters
  `.reflect/index.sqlite` and deleting the index still loses nothing. No
  sync state means no `Syncing contacts...`, stale counts, or error badges.
- **TypeScript owns policy.** `ContactsService`
  (`packages/core/src/contacts/contacts-service.ts`) exposes the lookups
  and the matching logic (person-like titles, attendee email → person
  note); the card and the meeting flow consume them.
- **Packaging.** The `com.apple.security.personal-information.addressbook`
  entitlement and an `NSContactsUsageDescription` string. iOS uses the same
  framework, so mobile inherits it (v1 disabled contact sync on mobile).

## v1 → v2 mapping

| v1                                             | v2                                               |
| ---------------------------------------------- | ------------------------------------------------ |
| OAuth-synced copy of provider address books    | Live, on-demand reads of Apple Contacts          |
| "N contacts" sync status and error badges      | No sync, no status — permission on/off only      |
| Custom-name edits stored in Reflect's store    | Corrections live in the person note's markdown   |
| Attendee names written back to contact entries | Strictly read-only                               |
| Mobile background sync disabled                | Same framework on iOS; no separate sync story    |

## Explicitly not ported

- The provider credential lifecycle and the contacts side of "Connected
  third-party accounts".
- The local contact mirror and its sync machinery.
- v1's non-features: no CSV/vCard import, no AI enrichment, no write-back.

## Resolved questions

- **Person-note matching.** Exact title ↔ full-name equality (see above).
  Fuzzy matching and a `#person` opt-in were dropped: exactness alone kills
  two-word-title false positives.
- **Photos.** Deferred. If person notes get photos, they go into `assets/`
  on explicit Add, never automatically.
- **Privacy doc.** [docs/privacy.md](../privacy.md) has an Apple Contacts
  section: on-device reads, no mirror, details enter a note only on Add.
