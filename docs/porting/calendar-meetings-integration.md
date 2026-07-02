# Porting calendar / meetings integration

**Status: shipped (macOS desktop).** The v1 feature — the day's meetings
beside the daily note, one action to turn a meeting into a backlinked note —
is one of Reflect's defining loops and ports to v2 with the same shape. What
changes completely is how calendars are reached.

Landed as: the `calendar` Rust module
(`apps/desktop/src-tauri/src/calendar.rs`), typed bindings + display policy
in `packages/core/src/calendar/`, the `addMeetingToDaily` action
(`packages/core/src/actions/add-meeting.ts`), the Settings **Calendar**
section, and the Events section in the daily context sidebar with its
add-meeting dialog. iOS still inherits the EventKit approach later (its
Info.plist/entitlements live in the generated Xcode project, not this
bundle config).

## What v1 did

- Connected Google, Microsoft, or iCloud calendars via OAuth / app-specific
  passwords, with credentials held server-side.
- Daily notes showed an **Events** sidebar (auto-refreshing) with the day's
  meetings from the calendars the user enabled.
- Clicking a meeting opened an **Add event** modal; submitting created or
  found a meeting note, created person notes for attendees, and backlinked
  all of them from the daily note.

## Why the v1 approach can't port

Provider OAuth requires a confidential client secret and redirect endpoints
held on a server. v2 is open-source and client-only: there is no server to
hold secrets, and a client secret shipped in an open-source binary is
public. Per-provider API integrations (Google Calendar API, Microsoft Graph,
CalDAV) are therefore out.

## How it will work in v2

### Apple Calendar via EventKit

v2 reads the calendars macOS already has, through the EventKit framework.
This is a smaller integration than it sounds like a regression:
**macOS Calendar already aggregates Google, Microsoft/Exchange, and iCloud
accounts.** A user who adds their Google account in System Settings →
Internet Accounts sees those events in Reflect with zero OAuth — Apple
maintains the sync. Access is read-only and entirely local; no network call
is added to [docs/privacy.md](../privacy.md)'s inventory.

### User experience

1. **Enabling.** A **Calendar** section in Settings with a single switch.
   Turning it on triggers the standard macOS permission prompt ("Reflect
   would like to access your calendar"). Denied or revoked permission shows
   an inline explanation with a button to System Settings — no error badges
   or revoke-and-reconnect loops, because there are no credentials to go
   stale.
2. **Choosing calendars.** Once granted, the section lists every calendar
   on the Mac (across all accounts) with checkboxes, mirroring v1's
   "2/5 calendars" selector. Enabled calendar identifiers are stored in the
   user settings file.
3. **Events on the daily note.** Today's events from enabled calendars
   appear in a panel on the daily note: title and start time (respecting the
   existing time-format setting), declined and all-day/busy-placeholder
   events filtered out, as in v1.
4. **Add to daily note.** Each event has one primary action, carrying over
   the v1 modal: editable meeting name, editable attendee list, and a
   "create backlinked note?" choice. Submitting writes plain markdown into
   the daily note — a `[[Meeting name]]` link and `[[Person]]` links per
   attendee — and creates the meeting/person notes if missing. With the
   [contacts integration](./contacts-integration.md) on, a fresh person note
   is pre-filled from the Apple Contacts entry matching the attendee's
   invite email. After that, they are ordinary notes; nothing about them
   stays tied to the calendar.

### Architecture

- **Rust owns the capability.** A `calendar` module in
  `apps/desktop/src-tauri/src/` binds EventKit through the `objc2` /
  `objc2-event-kit` crates (the codebase is pure Rust today and stays that
  way — no Swift). Commands: request access, list calendars, list events
  for a date range.
- **TypeScript owns policy.** `@reflect/core` gets bridge methods (via
  `packages/core/src/ipc/bridge.ts`) and the note-writing action for "add
  meeting"; the daily-note panel consumes them. Events are **fetched live,
  not indexed** — EventKit is fast and local, the SQLite index stays a
  projection of markdown only, and no calendar data is ever persisted
  except the markdown the user explicitly creates.
- **Packaging.** The hardened-runtime entitlement
  (`com.apple.security.personal-information.calendars`) and an
  `NSCalendarsFullAccessUsageDescription` string join the bundle config;
  notarization is already in place
  ([docs/macos-distribution.md](../macos-distribution.md)).
- **iOS.** EventKit is the same API on iOS, so the mobile companion
  ([plans/19-mobile.md](../plans/19-mobile.md)) inherits this integration
  rather than needing a separate "mobile sync" story like v1's Capacitor
  builds did.

## v1 → v2 mapping

| v1                                            | v2                                                  |
| --------------------------------------------- | --------------------------------------------------- |
| OAuth per provider, tokens on Reflect servers | One OS permission prompt; Apple holds the accounts  |
| Connected-accounts page, error badges, revoke | A Settings switch + calendar checkboxes             |
| Server polls providers; 10-min refresh        | Live local reads + EventKit change notifications    |
| Meeting metadata in the cloud database        | Only user-created markdown persists                 |
| Attendee names written back to contacts       | Read-only; see [contacts](./contacts-integration.md) |

## Explicitly not ported

- Direct Google/Microsoft/CalDAV connections and the whole credential
  lifecycle (connect, revoke, token refresh, error recovery).
- Any write access to calendars (v1 was read-only too; v2 keeps that).
- Meeting location / organizer / conference links (v1 didn't surface them
  either; can be revisited since EventKit exposes them).

## Decisions (were open questions)

- The events panel is a **context-sidebar section** on the daily note,
  tracking the focused day; it can move into the daily-note header once that
  layout settles.
- "Create backlinked note?" **defaults on for recurring events** (v1's
  behavior — EventKit's `hasRecurrenceRules` is plumbed through as
  `recurring`), off otherwise. Meeting notes are reused per title: a
  recurring "Standup" links one `[[Standup]]` note from every day.
- The daily-note markdown lands under a `## Meetings` heading
  (`appendUnderHeading`), one bullet per meeting in v1's exact line shape:
  `- 9:00am met with [[Person A]], [[Person B]] for [[Meeting]]`. As in v1,
  an unchecked "create backlinked note" writes the meeting name as plain
  text, and untitled / "block" / "busy" events never reach the panel. Two
  deliberate v1 deviations: no nested empty bullet under the line (the v2
  serializer drops empty list items), and re-adding a backlinked meeting is
  idempotent instead of appending a duplicate.
- No Google-OAuth-shaped hint; the Settings copy points at
  System Settings → Internet Accounts when no calendars are found.
