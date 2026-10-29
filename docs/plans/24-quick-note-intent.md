# Plan 24 — Quick Note Intent (Siri / Shortcuts / Action button)

**Goal:** capture a one-liner from anywhere on iOS ("Hey Siri, add a note in Reflect",
the Action button, a lock-screen Shortcuts widget, the Shortcuts app) and land it as a
bullet in the capture-day daily note. Successive quick notes must form **one growing
bullet list**, not a stack of gap-separated one-item lists. No new pipeline: a new
*producer* for the App Group inbox (Plan 11 envelopes) plus one drain refinement.

**Depends on:** Plan 11 (envelopes, inbox, drain), the iOS share extension (App Group
inbox + Rust relay, `CaptureInbox.swift`), audio-memos wave 3 (`RecordingIntents.swift`:
the existing `AppShortcutsProvider` and the in-app `openAppWhenRun = false` pattern).

**Status:** Phases 1–2 implemented. The Phase 0 spike and Phase 3 simulator pass **ran
green on the iOS 26.4 simulator** (2026-08-12): the App Shortcut auto-registered, the
intent ran with the app killed and returned "Saved" near-instantly, and **no app process
lingered and the webview never booted** (the envelope stayed spooled until the next real
launch, so the background-launch weight concern is moot). The envelope was schema-exact,
drained on next launch, and a second capture joined the first as one bullet list
(checked in the raw bytes). Remaining before TestFlight: the physical-device pass (Siri
from the lock screen with Face ID, Action button, dictation quality).

**Not in scope:**

- A lock-screen widget / iOS 18 Control opening an in-app capture sheet: a separate,
  complementary feature.
- An App Intents *extension* target (see the architecture decision).
- Android / desktop producers (they join by adding a `source` member, not a new shape).
- An immediate drain when the intent fires while the app is foregrounded (see "Landing
  latency").

## Where we stand

**Reused unchanged:**

- **The inbox contract.** The share extension spools `TextCaptureEnvelope` JSON into the
  App Group `inbox/`; the Rust relay moves committed files into `.reflect/inbox/` (bytes
  only); `drainTextCapture` validates and appends `- <text>` to the capture-day daily.
  Atomic spool, caps, folding, and quarantine already exist.
- **List-editing machinery.** `markdown/append-list-item.ts` already inserts into an
  existing list with the real parser: `appendListItemAtHeading` extends a section's
  `BulletList` with its own marker ("switching it would split the list in two"). The new
  helper is its note-tail sibling, not a line-regex heuristic; the parser already tells
  nested lists, indented code, ordered lists, and fences apart.
- **Triggers.** `capture-controller.ts` runs relay + drain on launch and on every return
  to foreground.
- **Intent precedent.** `RecordingIntents.swift`: app-target `AppIntent`s, one
  `ReflectAppShortcuts` provider, and `StopRecordingSiriIntent` proving in-app execution.
- **Flavor isolation.** `CaptureInbox.groupId` switches dev/prod App Group on `#if DEBUG`,
  matching Rust's `debug_assertions`; an app-target producer inherits it.

**Gaps closed:**

1. **No hands-free text producer** (only the share sheet and `reflect://append`).
2. **Bullets do not coalesce.** `appendBlock` always inserts a blank line, so two quick
   notes render as two lists.

## Architecture decision: the intent lives in the app target

Beside `RecordingIntents.swift`, not in a new App Intents extension:

- **The `AppShortcutsProvider` is singular** (app *or* extension, the latter iOS 17+).
  Reflect's lives in the app target because the recording intents must run in-process
  (they post `NotificationCenter` names the recording plugin observes). An
  extension-hosted intent could never get a zero-setup Siri phrase without migrating the
  whole provider and breaking the recording shortcuts.
- **`perform()` is cheap even on a cold launch.** It touches only Foundation and the App
  Group container (one atomic write) and never waits on the webview or graph.
- **Bonus:** if the background launch boots far enough to run the launch pass, the note
  lands before the user reopens the app.

Fallback if the device pass shows unacceptable Siri latency or battery cost: an App
Intents extension sharing `CaptureInbox.swift`, losing the Siri phrase (Shortcuts/Action
button only), or a full provider migration. Decide then.

## Landing latency (the contract)

The guarantee is **durability, not visibility**: the envelope is committed before
`perform()` returns. The bullet appears on the next relay + drain (launch pass, next
foreground, or next focus/visibility trigger). So the Siri dialog says **"Saved"**, not
"added to today's note". The target is the **capture-day** note (`capturedAt`), so a 23:59
capture drained next morning lands on the right day.

## Phase 0 — spike: background launch of an in-app intent (gates Phase 2 only)

The one unverified assumption: background-launching the **Tauri** app (never designed to
boot without a foreground scene) to run an intent is safe and fast. A throwaway intent
(write a marker file, return a dialog), run with the app killed from Shortcuts and Siri,
must show: `perform()` runs and the file lands; Siri round-trip within ~2 s; no crash or
wedge of the next foreground launch. A failure flips Phase 2 to the extension fallback
before real Swift work. Phase 1 proceeds regardless.

## Phase 1 — schema + drain coalescing (platform-neutral TS)

1. **`'ios-intent'`** joins `textCaptureSourceSchema`: provenance only, no shape or
   version change. The parity corpus covers the link wire message and is untouched.
2. **`appendListItem(source, text, kind)`** in `append-list-item.ts`, parser-based like
   `appendListItemAtHeading`: look at the **last top-level block**. If it is a
   `BulletList` and the marker rules allow, insert directly after it with a single line
   ending. Otherwise fall back to `appendBlock` with the canonical form (`- text` /
   `- [ ] text` / `+ [ ] text`). The syntax tree makes hard cases trivial: a nested tail
   is inside the `BulletList`; code, ordered lists, fences, and prose are not lists.
   **Marker rules** (in CommonMark a different marker starts a *new* list):
   - `append` adopts the list's marker and always joins.
   - `checkbox` adopts the marker **unless it is `+`**: `+ [ ]` must stay unambiguously a
     task for the Tasks projection, so after a `+` list it falls back to `- [ ] text`.
   - `task` is fixed at `+ [ ] text` and joins only a `+` list.
   So kind stays recoverable from the line: no brackets = append, `-`/`*` with brackets
   = checkbox, `+` with brackets = task.
3. **`drainTextCapture`** uses `appendListItem` for **all kinds and sources** and **drops
   the same-line dedup scan** (decided 2026-08-11). Both are deliberate behavior changes
   for deep-link and share captures too. Accepted failure mode: a crash between the note
   write and inbox removal re-appends one line once. Payload-level dedup is exactly the
   false positive Alex opted out of. `deduped` becomes link-capture-only.
4. **Tests:** tail shapes and marker rules, two captures make one list, duplicates allowed,
   `ios-intent` drains, and a privacy regression: text captures into a `private: true`
   daily never make a scrape/AI call (they have no enrichment leg by construction).

## Phase 2 — the Swift producer

1. **`CaptureInbox.swift`:** `spoolText(_:source:)` takes a `source` with no default, so
   the compiler finds every call site (share passes `"ios-share"`, intent `"ios-intent"`).
2. **`QuickNoteIntent.swift`**, modeled on `RecordingIntents.swift`:
   - A `text` parameter with a `requestValueDialog`, so Siri prompts and dictates when it
     is empty.
   - `openAppWhenRun = false`. Plain `async` `perform()` with **no `@MainActor`**, so the
     write never queues behind app-boot main-thread work. Empty text reprompts. A spool
     failure throws, so Siri reports failure instead of claiming "Saved".
   - `authenticationPolicy` set **explicitly** to `.requiresLocalDeviceAuthentication`.
     Apple's default `.alwaysAllowed` runs on a locked device, and `.requiresAuthentication`
     can run on a locked iPhone when an unlocked paired Watch authenticates. Until the App
     Group file-protection class is verified for locked writes, the writing device must be
     unlocked itself; Face ID satisfies this invisibly from the lock screen. Relax stepwise
     only after that verification.
3. **`ReflectAppShortcuts`** gains the quick-note `AppShortcut` and phrases.
4. **Project plumbing:** add `ShareExtension/CaptureInbox.swift` to the **app target** by
   path (the existing shared-source pattern) in **both** `src-tauri/ios.project.yml` and
   `gen/apple/project.yml` (synced by hand), then `xcodegen generate` and inspect the
   `project.pbxproj` diff per `docs/contributing/mobile-simulator.md`. No new target,
   entitlements, Info.plist, or Rust changes.

## Phase 3 — verification

- **Simulator:** run the intent with the app killed / backgrounded / foregrounded; reopen
  → one coalescing list; same text twice → two bullets. Regression: share text and link
  shares still land; recording shortcuts still run.
- **Device pass (owed, with Alex):** lock-screen Siri (Face ID), Action button, Shortcuts
  widget, dictation; dev flavor spools only to the dev App Group; Siri latency with the
  app killed (the go/no-go for the extension fallback).

## Resolved decisions

1. **Duplicates are allowed** (Alex, 2026-08-11). The dedup scan's only remaining value
   was crash-retry idempotency, and that narrow failure mode is accepted. Revisit only if
   real usage shows a problem.

## Open questions

1. **Siri phrase wording.** Phrases go live in Siri, Spotlight, and Shortcuts on install,
   so they are user-facing. "Add a note in Reflect" may collide with Apple Notes. The
   device pass must try variants before any TestFlight build.
