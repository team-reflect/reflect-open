# Porting the share extension

**v2 status: implemented.** The `ShareExtension` target
(`gen/apple/ShareExtension/`, declared in `ios.project.yml`) accepts URLs,
web pages, and text from the share sheet and spools Plan 11 capture
envelopes into the App Group inbox (`group.app.reflect/inbox/`), offline,
with no graph access. The app relays them into `.reflect/inbox/`
(`capture_shared_inbox_relay`, `src-tauri/src/capture.rs`) and the shared
drain/enrich pipeline materializes them; the mobile tree mounts
`CaptureProvider`, which relays + drains on graph open and every foreground
(`visibilitychange`). Safari captures carry title, selection, and the meta
description in-page (`ExtensionClass.js` → `metaDescription`), so an
offline save reads complete; enrichment replaces the description later.
Non-URL text saves as a daily-note bullet (`kind: append`,
`source: ios-share`). Remaining release-gate work: a device pass on a
TestFlight build (earlier TestFlight builds failed every share because CI
export dropped the appex App Group entitlement; see the CI-signing note
below).

## What V1 mobile does

A SwiftUI extension target, `ios/App/ShareExtension/`:

- **Accepts** URLs, web pages, and text (`Info.plist` activation rules: 1
  web URL, text, 1 web page, dictionary version 2 for Chrome).
- **Extracts metadata in-page**: `ExtensionClass.js` runs as a
  preprocessor and pulls `document.title`, the URL, the selection, and
  `og:description`/`description`.
- **Authenticates without the app**: OAuth tokens and the graph ID come
  from App Group defaults (`group.ReflectData`,
  `ios/App/Shared/ReflectDefaults.swift`), written by the auth-sync bridge
  at sign-in.
- **POSTs to the API**: `POST /api/graphs/{graphId}/links/async` with url,
  title, description, and highlights. Enrichment runs in V1's server
  pipeline; the client later applies the link note, and the daily note
  gets its `[[Links]]` entry.
- **UI states**: loading → "Saved to Reflect!"; "Please sign in using
  Reflect app" without tokens; a failure state; and a tip that sharing
  highlights doesn't work from some apps.
- **Errors are queued, not lost**: failures append to
  `ReflectDefaults.extensionErrors` and go to Sentry the next time the app
  foregrounds.

## What changes in v2, and why

No API to POST to, so the design inverts to *write locally, ingest on
launch*:

- **The extension writes a capture envelope into an App Group inbox** (the
  same model as desktop Chrome capture, Plan 11: URL, title,
  selection/highlights, provenance, captured-at). Extensions must **not**
  open the Git repo or SQLite; the inbox is the only contract.
- **The app ingests on launch/foreground**: envelope → markdown (a
  `[[Links]]` entry on the capture-day daily note, and a link note for
  richer captures), then indexes and syncs through the in-process
  file-change seam.
- **AI enrichment happens at ingest, BYOK, in the app**, never in the
  extension, which holds no provider keys. If the capture or target note
  is `private: true`, enrichment is skipped and the raw link still saved.
- **Auth disappears**: no tokens, graph-ID handoff, or signed-out state.
  Failure modes shrink to "no graph yet" and disk errors.
- The two-tap UX, in-page metadata extraction, and
  queued-errors-surface-later port as requirements.

## V1 → v2 mapping

| V1                                            | v2                                                            |
| --------------------------------------------- | -------------------------------------------------------------- |
| POST `/links/async` with App Group tokens     | Capture envelope into the App Group inbox                      |
| Server-side enrichment via operations         | BYOK enrichment at ingest, in-app, privacy-checked              |
| "Please sign in" state                        | Gone (no accounts); "set up a graph first" at most              |
| `ExtensionClass.js` metadata extraction       | Port: same fields into the envelope                             |
| Errors queued in App Group defaults           | Same pattern: queue in the container, surface in-app            |
| Daily-note `[[Links]]` entry (applied later)  | Same product shape, written locally at ingest                   |

## Resolved decisions

- **One envelope schema, two producers**: the extension mirrors
  `capture-envelope.ts` (`LinkCaptureEnvelope`/`TextCaptureEnvelope` in
  `CaptureInbox.swift`); provenance is the widened `source: 'ios-share'`
  member, never a new variant. Safari's description rides the optional
  `metaDescription` field, which the drain writes into the raw save and
  enrichment replaces in place.
- **App Group provisioned with this wave**: `group.app.reflect` on both
  targets. The extension writes `<uuid>.json` atomically (tmp + same-volume
  rename); the Rust relay moves committed files into the graph inbox (copy
  + atomic write + delete, since the containers are different volumes) and
  quarantines oversized files beside the shared inbox.
- **Ingest is foreground-only** (like sync): graph open, window
  focus/online, and `visibilitychange` → visible schedule the relay+drain;
  no background refresh task.
- **Entitlements are hand-maintained per flavor** (superseding the
  spec-driven `entitlements.properties` approach): each target commits a
  release `.entitlements` and a dev `.dev.entitlements`, and
  `ios.project.yml` picks one per configuration via
  `CODE_SIGN_ENTITLEMENTS`. With no xcodegen `entitlements:` block, regens
  (including `tauri ios init`) never touch the files, so the old
  wipe-to-empty-dict failure cannot recur, and the dev flavor
  (`app.reflect.ios.dev`, `group.app.reflect.dev`) has its own capability
  set.
- **CI signing must preserve the App Group.** Tauri's App Store Connect
  API-key flow (the TestFlight workflow) archives with signing disabled and
  dummy-signs only the app binary; `xcodebuild -exportArchive` keeps only
  entitlements already in a signature, so the appex shipped without the
  App Group, the container lookup returned nil, and every share failed
  with "Couldn't save" (local builds were fine because Xcode signs during
  archive). A post-build phase on the ShareExtension target ad-hoc signs
  the appex with its entitlements when `CODE_SIGNING_ALLOWED=NO`, and
  `apps/desktop/scripts/build-ios.ts` refuses an IPA whose appex lacks
  `group.app.reflect`.
