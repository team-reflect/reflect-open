# Porting calendar / meetings integration

**Status: shipped (macOS desktop).** The v1 loop (the day's meetings beside
the daily note, one action to turn a meeting into a backlinked note) ports
with the same shape. Only how calendars are reached changes.

Landed as: `apps/desktop/src-tauri/src/calendar.rs`, bindings and display
policy in `packages/core/src/calendar/`, the `addMeetingToDaily` action
(`packages/core/src/contacts/meeting-service.ts`), the Settings
**Calendar** section, and the Events section in the daily context sidebar
with its add-meeting dialog. iOS inherits the EventKit approach later (its
Info.plist/entitlements live in the generated Xcode project, not this
bundle config).

## What v1 did

- Connected Google, Microsoft, or iCloud calendars via OAuth / app-specific
  passwords, with credentials held server-side.
- Daily notes showed an auto-refreshing **Events** sidebar with the day's
  meetings from enabled calendars.
- Clicking a meeting opened an **Add event** modal; submitting created or
  found a meeting note, created attendee person notes, and backlinked them
  all from the daily note.

## Why the v1 approach can't port

Provider OAuth needs a confidential client secret and redirect endpoints on
a server. v2 is open-source and client-only, so a shipped client secret
would be public. Google Calendar API, Microsoft Graph, and CalDAV are out.

## How it will work in v2

### Apple Calendar via EventKit

v2 reads the calendars macOS already has. **macOS Calendar already
aggregates Google, Microsoft/Exchange, and iCloud accounts**, so a user who
adds Google in System Settings → Internet Accounts sees those events with
zero OAuth. Access is read-only and local; no network call is added to
[docs/privacy.md](../privacy.md).

### User experience

1. **Enabling.** A **Calendar** switch in Settings triggers the macOS
   permission prompt. Denied or revoked permission shows an inline
   explanation with a button to System Settings. No error badges or
   reconnect loops: there are no credentials to go stale.
2. **Choosing calendars.** The section lists every calendar on the Mac with
   checkboxes (like v1's "2/5 calendars"). Enabled identifiers are stored in
   the user settings file.
3. **Events on the daily note.** Today's events from enabled calendars, with
   title and start time (per the time-format setting); declined and
   all-day/busy-placeholder events are filtered out, as in v1.
4. **Add to daily note.** One primary action per event, carrying over v1's
   modal: editable meeting name, editable attendees, and a "create
   backlinked note?" choice. Submitting writes plain markdown (a
   `[[Meeting name]]` link and `[[Person]]` per attendee) and creates
   missing notes. With [contacts](./contacts-integration.md) on, a new
   person note is pre-filled from the Apple Contacts entry matching the
   invite email. After that they are ordinary notes, not tied to the
   calendar. Existing `#person` notes are reused by explicit email
   ownership even when the title differs. Conflicting or unaddressable
   owners are written as plain text and create no person note.

### Architecture

- **Rust owns the capability.** The `calendar` module binds EventKit through
  `objc2` / `objc2-event-kit` (the codebase stays pure Rust, no Swift).
  Commands: request access, list calendars, list events for a range.
- **TypeScript owns policy.** `CalendarService`
  (`packages/core/src/calendar/calendar-service.ts`) and `MeetingService`
  (`packages/core/src/contacts/meeting-service.ts`) feed the daily-note
  panel. Events are **fetched live, not indexed**: EventKit is fast and
  local, the index stays a projection of markdown, and no calendar data
  persists except markdown the user creates.
- **Packaging.** The `com.apple.security.personal-information.calendars`
  entitlement and an `NSCalendarsFullAccessUsageDescription` string;
  notarization is already in place ([docs/distribution.md](../distribution.md)).
- **iOS.** EventKit is the same API, so the mobile companion
  ([plans/19-mobile.md](../plans/19-mobile.md)) inherits this instead of
  needing a separate sync story like v1's Capacitor builds.

## v1 → v2 mapping

| v1                                            | v2                                                  |
| --------------------------------------------- | --------------------------------------------------- |
| OAuth per provider, tokens on Reflect servers | One OS permission prompt; Apple holds the accounts  |
| Connected-accounts page, error badges, revoke | A Settings switch + calendar checkboxes             |
| Server polls providers; 10-min refresh        | Live local reads + EventKit change notifications    |
| Meeting metadata in the cloud database        | Only user-created markdown persists                 |
| Attendee names written back to contacts       | Read-only; see [contacts](./contacts-integration.md) |

## Explicitly not ported

- Direct Google/Microsoft/CalDAV connections and the credential lifecycle.
- Write access to calendars (v1 was read-only too).
- Location / organizer / conference links (v1 didn't show them either;
  EventKit exposes them if wanted later).

## Decisions (were open questions)

- The events panel is a **context-sidebar section** tracking the focused
  day; it can move into the daily-note header once that layout settles.
- "Create backlinked note?" **defaults on for recurring events** (v1
  behavior; EventKit's `hasRecurrenceRules` is plumbed as `recurring`), off
  otherwise. Meeting notes are reused per title: a recurring "Standup"
  links one `[[Standup]]` note every day.
- Markdown lands under a `## Meetings` heading
  (`appendListItemUnderHeading`), one bullet per meeting in v1's line
  shape: `- 9:00am met with [[Person A]], [[Person B]] for [[Meeting]]`. As
  in v1, unchecking "create backlinked note" writes the name as plain text,
  and untitled / "block" / "busy" events never reach the panel. Two
  deliberate deviations: no nested empty bullet (the serializer drops empty
  list items), and re-adding a backlinked meeting is idempotent.
- No Google-OAuth-shaped hint; when no calendars are found, the Settings
  copy points at System Settings → Internet Accounts.
