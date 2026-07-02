# Porting contacts integration

**Status: shipped.** In v1, contacts turned meeting
attendees and name-like notes into real person notes without manual data
entry. v2 keeps that role but reads the **Apple Contacts** store instead of
syncing provider address books through a server.

Shipped: the Rust `contacts` capability (`CNContactStore` via `objc2`), the
Settings → System integrations switch with the permission flow, the
suggested-contact card, contacts in the `[[` link menu, and the
meeting-attendee half: the
[calendar flow](./calendar-meetings-integration.md)'s add-meeting action
resolves each attendee's invite email through `resolveAttendeeContact`
(gated on the integration being enabled and readable) and pre-fills the
person notes it creates; on a miss the note is created bare, as v1 did.

Decisions taken at implementation time:

- **Person-note matching is exact.** The card appears only when the note
  title equals a contact's full name — case- and diacritic-insensitive,
  whitespace-collapsed, mirroring the framework predicate's own folding — with
  no `#person` tag required, and word-prefix hits from the framework's name
  predicate discarded (`matchContactForTitle`).
- **No photos in v1.** Add writes a `- Type: #person` typing line (v1's Type
  field, the same convention the meeting flow uses) plus every email and
  phone as plain markdown bullets; photos (binary → `assets/`) can follow
  without rework.
- **Suppression is content-based, dismissals per contact — v1's exact
  model.** A note whose body already carries contact details (an email, an
  `Email:`/`Phone:` bullet) gets no card, which is also what hides the card
  after Add — a single write, no frontmatter mark. Ignore records the
  contact's name in the note's `ignoredContacts` frontmatter list (v1's
  `ignoredContactNames`), so a retitled note stays eligible for its own
  suggestion and the state travels with the note through sync and export.
- **Contacts join the `[[` link menu, like v1's backlink menu.** Word-prefix
  matches (min two typed characters, capped, deduped against notes the link
  would resolve to) appear after note suggestions; selecting one inserts the
  link and creates the person note prefilled with the same details block Add
  writes. A contact row for the exact typed name replaces the bare Create
  row.
- **No `mailto:`/`tel:` links.** v1's rich editor hid link URLs; v2 notes are
  markdown the user owns, where the syntax would double every value — and the
  editor's link opener is scoped to `https`. Plain values keep the files
  clean; autolinking can make them clickable without markup.

## What v1 did

- Synced contacts (names, emails, phones, photos) from connected Google,
  Microsoft, or iCloud accounts — the same credentials as calendar.
- Showed a **Suggested contact** card on notes whose subject looked like a
  person's name, with one action to merge the contact's details into the
  note.
- Resolved meeting attendees against the contact store so "add meeting to
  daily note" produced pre-populated person notes.

## Why the v1 approach can't port

Same reason as calendar: provider contact APIs require OAuth with
server-held secrets, and v2 has no server. The OS-native replacement is the
Contacts framework (`CNContactStore`), which — like EventKit — already
aggregates Google, Exchange, and iCloud contacts the user has added to
macOS.

## How it will work in v2

### User experience

1. **Enabling.** A **Contacts** switch in Settings (paired with Calendar —
   one "System integrations" section). Turning it on triggers the macOS
   contacts permission prompt; denial shows an inline pointer to System
   Settings.
2. **Meeting attendees become person notes.** When a meeting is added from
   the [calendar flow](./calendar-meetings-integration.md), each attendee
   email is looked up in Apple Contacts. On a match, the created person note
   is pre-filled (name, email, phone); on a miss, a person note is still
   created from the attendee email, as in v1.
3. **Suggested contact.** On a note whose title matches a contact's name, a
   card offers the contact's details (photo, primary email, phone) with
   **Add** — writes the fields into the note as plain markdown — and
   **Ignore** — dismisses the suggestion for that note.
4. **Nothing syncs anywhere.** Contact data appears in a note only when the
   user explicitly adds it, at which point it is ordinary markdown owned by
   the graph. Reflect never writes back to the address book.

### Architecture

- **Rust owns the capability.** A `contacts` module in
  `apps/desktop/src-tauri/src/` binds the Contacts framework via `objc2`
  bindings. Commands: request access, look up by email, look up by name.
- **Lookups are live queries, not a mirror.** v1 copied the whole address
  book into its local store and showed "N contacts" sync status. v2 queries
  `CNContactStore` on demand (attendee resolution, title match) and persists
  nothing: the address book never enters `.reflect/index.sqlite`, so the
  index remains a pure projection of markdown and deleting it still loses
  nothing. No sync state means no `Syncing contacts...`, no stale counts,
  no error badges.
- **TypeScript owns policy.** `@reflect/core` exposes bridge methods and
  the matching logic (which note titles count as person-like, how attendee
  emails map to person notes); the suggested-contact card and the meeting
  flow consume them. Per-note "ignore" dismissals persist in the note's
  frontmatter or the settings file — small, explicit state either way.
- **Packaging.** `com.apple.security.personal-information.addressbook`
  entitlement plus an `NSContactsUsageDescription` string. iOS uses the
  same framework, so mobile inherits the integration (v1 had contact sync
  disabled on mobile entirely).

## v1 → v2 mapping

| v1                                             | v2                                               |
| ---------------------------------------------- | ------------------------------------------------ |
| OAuth-synced copy of provider address books    | Live, on-demand reads of Apple Contacts          |
| "N contacts" sync status and error badges      | No sync, no status — permission on/off only      |
| Custom-name edits stored in Reflect's store    | Corrections live in the person note's markdown   |
| Attendee names written back to contact entries | Strictly read-only                               |
| Mobile background sync disabled                | Same framework on iOS; no separate sync story    |

## Explicitly not ported

- The provider credential lifecycle and the contacts side of
  "Connected third-party accounts".
- The local contact mirror and its sync machinery.
- v1's non-features stay non-features: no CSV/vCard bulk import, no AI
  enrichment, no write-back to providers.

## Resolved questions

- **Person-note matching.** Exact title ↔ full-name equality (see the
  decisions above). Fuzzy matching and a `#person` opt-in were considered and
  dropped: exactness alone kills the two-word-title false positives.
- **Photos.** Deferred — Add writes text fields only. If person notes grow
  photos, they'd be written into `assets/` on explicit add (never
  automatically).
- **Privacy-doc wording.** [docs/privacy.md](../privacy.md) has an Apple
  Contacts section: on-device reads, no mirror, details enter a note only on
  explicit Add.
