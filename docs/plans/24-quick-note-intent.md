# Plan 24 — Quick Note Intent (Siri / Shortcuts / Action button)

**Goal:** capture a one-liner from anywhere on iOS — "Hey Siri, add a note in
Reflect", the Action button, a lock-screen Shortcuts widget, or the Shortcuts
app — and have it land as a bullet in the capture-day daily note. Successive
quick notes must form **one growing bullet list**, not a stack of gap-separated
single-item lists. No new capture pipeline: this is a new *producer* for the
existing App Group inbox (Plan 11's envelope model) plus one drain refinement.

**Depends on:** Plan 11 (capture envelopes, inbox, drain), the iOS share
extension (App Group inbox + Rust relay, `CaptureInbox.swift`), audio-memos
wave 3 (`RecordingIntents.swift` — the app's existing `AppShortcutsProvider`
and the proven in-app `openAppWhenRun = false` intent pattern).

**Status:** planned.

**Explicitly not in scope:**

- A lock-screen widget / iOS 18 Control that opens an in-app capture sheet
  (tap → keyboard). That is a separate, complementary feature with its own
  plan; nothing here blocks it.
- An App Intents *extension* target. See the architecture decision below —
  revisit only if background app launches prove too heavy in practice.
- Android / desktop producers (the envelope vocabulary already anticipates
  them; they join by adding a `source` member, not a new shape).
- An immediate in-webview drain trigger when the intent fires while the app
  is foregrounded (the note lands on the next existing trigger; see
  "Landing latency" below).

## Where we stand

**What already exists (and is reused unchanged):**

- **The inbox contract.** The iOS share extension spools
  `TextCaptureEnvelope` JSON (`kind: "append"`, single folded line) into the
  App Group container's `inbox/`
  (`gen/apple/ShareExtension/CaptureInbox.swift`); the Rust relay
  (`capture_shared_inbox_relay`, `src-tauri/src/capture.rs`) moves committed
  `.json` files into the graph's `.reflect/inbox/` — bytes only, no
  validation; the drain (`packages/core/src/actions/capture-drain.ts` →
  `drainTextCapture`) validates against
  `textCaptureEnvelopeSchema` and appends `- <text>` to the capture-day
  daily note. Producer atomicity (`.json.tmp` → rename), the 64 KiB spool
  cap, UTF-16 field caps, whitespace folding, and quarantine all exist and
  are not touched.
- **List-editing machinery.** `packages/core/src/markdown/append-list-item.ts`
  already solves "insert an item into an existing list" with the real
  meowdown parser: `appendListItemAtHeading` finds a section's `BulletList`
  node and `listMark` extends it with the list's own `-`/`+`/`*` marker
  ("switching it would split the list in two"). This plan's helper is the
  note-tail sibling of that code, not a new line-regex heuristic — the
  parser already distinguishes nested lists, indented code blocks, ordered
  lists, and fences correctly, for free.
- **Relay/drain triggers.** `capture-controller.ts` runs relay + drain on
  graph launch and on every return to foreground
  (`visibilitychange` → visible, armed on mobile by `relaySharedInbox` in
  `capture-provider.tsx`).
- **Intent precedent.** `Sources/reflect-open/RecordingIntents.swift`:
  app-target `AppIntent`s (16.0-gated, `#if canImport(AppIntents)`), one
  `ReflectAppShortcuts: AppShortcutsProvider` with Siri phrases, and
  `StopRecordingSiriIntent` proving `openAppWhenRun = false` in-app
  execution.
- **Flavor isolation.** `CaptureInbox.groupId` switches dev/prod App Group on
  `#if DEBUG`, matching the Rust side's `debug_assertions` switch — an
  app-target producer inherits this for free.

**The two gaps this plan closes:**

1. **No hands-free text producer.** The only text producers are the share
   sheet (requires an app + share UI) and `reflect://append` deep links.
2. **Bullets don't coalesce.** `drainTextCapture` appends via `appendBlock`,
   which always inserts a blank line — two quick notes render as two separate
   one-item lists.

## Architecture decision: the intent lives in the app target

The intent compiles into the **app target**, beside `RecordingIntents.swift`,
not into a new App Intents extension:

- **The `AppShortcutsProvider` is singular.** An app gets exactly one
  provider (app *or* App Intents extension — iOS 17+ for the latter), and
  Reflect's already lives in the app target where its recording intents must
  execute (they post `NotificationCenter` names the recording plugin observes
  in-process). An extension-hosted quick-note intent could therefore never
  get a zero-setup Siri phrase without migrating the whole provider and
  breaking the recording shortcuts.
- **`perform()` is cheap even on a cold launch.** When the app isn't running,
  iOS launches it in the background to run an in-app intent — but
  `perform()` only touches Foundation + the App Group container (a single
  atomic file write), and deliberately does **not** wait on the webview or
  graph. The heavyweight Tauri boot proceeds independently.
- **Bonus:** if the background launch does boot the webview far enough to run
  the capture controller's launch pass, the note lands in the daily note
  before the user ever reopens the app.

Fallback if a device pass shows Siri latency or battery cost is unacceptable:
an App Intents extension (iOS 17+) sharing `CaptureInbox.swift`, accepting
the loss of the Siri App Shortcut phrase (Shortcuts-app/Action-button
invocation only) — or a wholesale provider migration. Decide then, not now.

## Landing latency (the contract, stated honestly)

The intent's guarantee is **durability, not visibility**: the envelope is
committed to the App Group inbox before `perform()` returns. The bullet
appears in the daily note on the next relay + drain trigger:

- app cold-launched in background by the intent → launch pass (if the webview
  boots) or next real open;
- app backgrounded → next return to foreground (existing `visibilitychange`
  trigger);
- app foregrounded during invocation (rare) → next focus/visibility trigger.

The Siri result dialog says **"Saved"** — not "added to today's note" — so
the copy never overpromises. The daily note targeted is the **capture-day**
note (`capturedAt` → `captureLocalDate`), so a 23:59 capture drained the next
morning still lands on the right day.

## Phase 0 — spike: background launch of an in-app intent (gates Phase 2 only)

The one genuinely unverified assumption is that iOS background-launching the
**Tauri** app to run an app-target intent is safe and fast: the app was never
designed to boot without a foreground scene. Before building Phase 2, hack a
throwaway intent into the app target (write a marker file to the App Group
container, return a dialog) and, with the app fully killed, run it from the
Shortcuts app and via Siri on a simulator + device:

- `perform()` executes and the file lands (proves the execution model);
- Siri round-trip latency is acceptable (target: dialog within ~2 s);
- the background boot neither crashes (watch Sentry/console for
  scene-assumption failures in the Tauri/webview init) nor wedges the
  subsequent real foreground launch.

Phase 1 is independent and proceeds regardless; a spike failure flips
Phase 2 to the App Intents extension fallback (see the architecture
decision) before any real Swift work is invested.

## Phase 1 — schema + drain coalescing (platform-neutral TS, CI-testable)

1. **`packages/core/src/actions/capture-envelope.ts`** — add `'ios-intent'`
   to `textCaptureSourceSchema` (the doc comment on it already names this
   exact extension point). Provenance only; no shape change, no version bump.
   The parity corpus (`capture-envelope.fixtures.json`) covers the *wire
   message* (link captures through the native host) and is untouched; the
   native host and Rust relay never see text-envelope sources.
2. **`packages/core/src/markdown/append-list-item.ts`** — new
   `appendListItem(source, text, kind)` (kind = `append` / `checkbox` /
   `task`), exported through `markdown/edit.ts` and `markdown/index.ts`.
   **Parser-based, beside the code it mirrors** — not a line-regex
   heuristic. Like `appendListItemAtHeading`: `splitFrontmatter` +
   `parseBody`, then look at the **last top-level block** of the body.
   - If that block is a `BulletList`, read its marker with the existing
     `listMark` helper and join when the kinds' marker rules allow
     (below): insert `<mark> <payload>` directly after the list's end
     with a single line ending (the same insertion mechanics as
     `appendListItemAtHeading`'s join branch). The syntax tree makes the
     hard cases trivial: a nested tail (markers legally pushed past
     3 spaces) is *inside* the `BulletList` node, an indented code block,
     ordered list, fence, or prose tail simply isn't one — all fall back.
   - **Marker rules per kind** (in CommonMark the marker is list
     structure — a `-` item directly after a `*` item is a *new* list):
     `append` adopts the list's marker and always joins. `checkbox`
     adopts the marker **unless it is `+`** — `+ [ ]` must stay
     unambiguously a task for the Tasks projection, so after a `+` list a
     checkbox falls back to its own `- [ ] text` block. `task` is fixed
     at `+ [ ] text` and joins only a `+` list. Kind therefore stays
     recoverable from the line form: no brackets = append, `-`/`*` with
     brackets = checkbox, `+` with brackets = task.
   - No trailing `BulletList`, or marker rules refuse the join → fall
     back to `appendBlock` with the canonical form (`- text` /
     `- [ ] text` / `+ [ ] text`). Line endings via the existing
     `lineEndingAt`/`documentLineEnding` helpers (CRLF-safe).
3. **`packages/core/src/actions/capture-drain.ts`** — `drainTextCapture`
   switches from `appendBlock` to `appendListItem` for **all three kinds**
   and all sources, and **drops the same-line dedup scan** (decided
   2026-08-11): duplicate quick notes are allowed until they prove to be a
   real problem. Both are deliberate behavior changes for deep-link and
   share-sheet captures too — coalescing and duplicate-tolerance apply
   everywhere. Accepted failure mode: a crash between the note write and
   `captureInboxRemove` re-appends the same line once on retry — rare and
   self-limited, and the alternative (payload-level dedup) is exactly the
   false-positive Alex opted out of. The outcome's `deduped` count becomes
   link-capture-only.
4. **Tests** (node project, `.test.ts`):
   - `append-list-item.test.ts` (extending the file's existing suite):
     empty note; prose tail; `-`/`*`/`+` bullet tails (append adopts each
     marker); checkbox after `-`/`*` joins, checkbox after `+` falls back
     to `- [ ]`; task after a `+ [ ]` list joins, task after a `-` list
     falls back as its own `+ [ ]` block; nested tail (two-space and
     four-space markers) appends at the outer level with the outer marker;
     indented code-block tail falls back; ordered-list tail falls back;
     fence tail falls back; trailing blank lines; CRLF documents;
     frontmatter-only note.
   - `capture-drain.test.ts`: two `append` envelopes on one day yield one
     two-item list; the *same* envelope content twice yields two bullets
     (duplicates allowed); `append` after `task` behaves per the marker
     rules; prose after the list starts a fresh list; `ios-intent` source
     drains.
   - Privacy regression: an `ios-intent` envelope draining into a daily
     note marked `private: true` writes only the local daily file — text
     captures have no enrichment leg by construction, and the test pins
     that no scrape/AI call is ever made for them.
   - `capture-envelope.test.ts`: `ios-intent` accepted, unknown sources
     rejected.

## Phase 2 — the Swift producer

1. **`gen/apple/ShareExtension/CaptureInbox.swift`** — parametrize the
   producer: `TextCaptureEnvelope.source` becomes a `var` set by a new
   `source` argument on `spoolText(_:source:)` with no default, so the
   compiler finds every call site. The share flow's one existing caller
   (`ShareState.swift`) passes `"ios-share"`; the intent passes
   `"ios-intent"`. No other changes — the folding, caps, and atomic spool
   are exactly what the intent needs.
2. **New `gen/apple/Sources/reflect-open/QuickNoteIntent.swift`** — modeled
   line-for-line on `RecordingIntents.swift` (`#if canImport(AppIntents)`,
   `@available(iOS 16.0, *)`):
   - `static var title = "Add quick note"`, description "Append a one-line
     note to today's daily note in Reflect."
   - `@Parameter(title: "Note", requestValueDialog: "What do you want to
     note down?") var text: String` — Siri prompts and dictates when the
     parameter is empty; Shortcuts users can bind it or leave "Ask Each
     Time".
   - `static var openAppWhenRun = false`. Plain `async` `perform()` (no
     `@MainActor` — the file write must not queue behind app-boot
     main-thread work) returning `some IntentResult & ProvidesDialog`:
     fold via `CaptureInbox.foldedLine`, empty →
     `throw $text.needsValueError(...)` to reprompt; spool; return
     `.result(dialog: "Saved")`. Spool failure throws so Siri reports
     failure honestly instead of claiming "Saved".
   - `static var authenticationPolicy` set **explicitly** to
     `.requiresLocalDeviceAuthentication` — Apple's documented default is
     `.alwaysAllowed` (runs on a locked device), and the milder
     `.requiresAuthentication` can still run on a locked iPhone when the
     user is authenticated elsewhere, e.g. an unlocked paired Watch. Until
     the App Group container's file-protection class is verified for
     locked writes, the contract is that the device performing the write
     is itself unlocked, which only the local-device policy guarantees.
     Face ID satisfies it invisibly from the lock screen. Relax stepwise
     (Watch/HomePod capture, then true no-unlock voice capture) only after
     that verification.
3. **`RecordingIntents.swift`** — add to `ReflectAppShortcuts`:
   `AppShortcut(intent: QuickNoteIntent(), phrases: ["Add a note in
   \(.applicationName)", "Take a quick note in \(.applicationName)"],
   shortTitle: "Quick note", systemImageName: "square.and.pencil")`.
4. **Project plumbing** — add `ShareExtension/CaptureInbox.swift` to the
   **app target's** sources by path (the established shared-source pattern:
   `StopRecordingLiveActivityIntent.swift` and
   `RecordingActivityAttributes.swift` already cross targets this way), in
   **both** `src-tauri/ios.project.yml` and `gen/apple/project.yml` (kept in
   sync by hand), then `xcodegen generate` and inspect the `project.pbxproj`
   diff per `docs/contributing/mobile-simulator.md`.
   `QuickNoteIntent.swift` is picked up by the existing `Sources` directory
   reference. No new target, no new entitlements (the app already carries
   the App Group), no Info.plist changes, no Rust changes.

## Phase 3 — verification

- `pnpm check` + targeted vitest runs for the Phase 1 files.
- **Simulator pass** (`pnpm tauri:ios:dev "iPhone 17 Pro"`): run the intent
  from the Shortcuts app with the app killed / backgrounded / foregrounded;
  verify the envelope spools, that reopening the app produces one coalescing
  bullet list in today's daily note, and that the same text captured twice
  produces two bullets. Regression: share-sheet text and link shares still
  land; recording shortcuts still appear and run.
- **Device pass (owed, with Alex):** Siri phrase from the lock screen
  (Face ID flow), Action button, lock-screen Shortcuts widget, dictation
  quality; confirm the dev flavor spools to the dev App Group only; Siri
  round-trip latency with the app killed (the go/no-go signal for the
  App Intents extension fallback).

## Resolved decisions

1. **Duplicates are allowed** (Alex, 2026-08-11). The drain's same-line dedup
   scan is removed for text captures: "coffee" captured twice in one day
   lands twice. The scan's only remaining value was crash-retry idempotency,
   and that failure mode (a crash in the narrow window between the note
   write and the spool removal, duplicating one line once) is accepted.
   Revisit only if real usage surfaces a problem.

## Open questions

1. **Siri phrase wording.** App Shortcut phrases are live in Siri,
   Spotlight, and the Shortcuts app the moment a build installs — they are
   user-facing metadata, not latent strings. "Add a note in Reflect" may
   also collide with Apple Notes' vocabulary in practice. The device pass
   must try variants before the phrase list ships in any TestFlight build.
