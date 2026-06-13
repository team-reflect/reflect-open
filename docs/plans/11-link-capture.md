# Plan 11 — Link Capture

> **Status (2026-06-12): Implemented.** The pipeline below is built end-to-end:
> `apps/extension` (WXT MV3, popup + queue + ⌘⇧K), `apps/native-host`
> (`reflect-capture-host`, bundled as a second sidecar), the capture inbox +
> watcher carve-out, `drainCaptureInbox`/`reconcileCaptureEnrichment` in
> `packages/core/src/actions/capture.ts`, and the desktop controller
> (`apps/desktop/src/lib/capture-controller.ts`). Two deliberate narrowings for
> the first release: browser-manifest registration is **macOS-only** (Windows
> HKCU keys / Linux paths land with Plan 15), and there is **no settings UI** —
> host registration is silent and the extension popup explains the
> missing-app/missing-graph states. Every capture creates a dedicated
> `notes/capture-<stamp>.md` (screenshots are always taken, so the
> "enough phase-1 content" condition below is always met) plus the daily
> `[[Links]]` backlink; enrichment status lives in the capture note's
> frontmatter (`captureStatus: pending | done | skipped`).

**Goal:** Launch-grade web capture: a Chrome extension hands URL/title/selection/
screenshot to the **installed desktop app** through a local **capture inbox**; the
desktop app owns all writes, BYOK AI enrichment, and privacy — appending to today's
daily note. Capture works **even when the desktop app is closed**: the raw link is
spooled immediately and enriched asynchronously later.

**Depends on:** Plan 02 (writes/assets), Plan 06 (append-to-today), Plan 10 (BYOK AI +
keychain + privacy).
**Unlocks:** the capture half of Reflect's daily-first spine.
**Research:** bridge options, app-closed behavior, and the mobile story are mapped in
[the bridge spike](../spikes/link-capture-bridge.md).

**Architecture:** the extension lives in `apps/extension`; all durable writes, AI
enrichment, and privacy checks go through `apps/desktop` + `@reflect/core`
(`actions/capture`). See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** WXT (Chrome extension framework, TS), `image` (Rust, screenshot
downscale). See [Libraries](libraries.md).

## Scope

**In:** Chrome extension (capture active URL, title, selection/highlights, screenshot),
the native-messaging host + capture inbox, desktop write path (daily-note `[[Links]]`
entry + optional dedicated note), screenshot assets, async enrichment (meta-tag scrape +
BYOK AI description), provenance frontmatter, privacy enforcement.
**Out:** Safari/iOS/Android share (later — but the capture envelope + inbox drain are
deliberately platform-agnostic so mobile reuses them; see the spike doc), full article
extraction / read-later (deferred), dedup-heavy clipping (basic dedup only).

## Architecture (inverted from V1: desktop owns writes)

V1 called a Reflect-hosted `link-description-api`. V2 must not. Instead:

- The **extension** captures and forwards; it stores **no model keys** and makes **no AI
  calls** — enrichment never happens in the extension.
- The **desktop app** owns durable writes, file paths, asset storage, keychain access,
  BYOK AI calls, and the `private: true` check.

### Bridge: native messaging host as a spooler (chosen)

The host is a **spooler, not a relay** — it never talks to the running app directly;
the inbox *is* the IPC:

- Chrome spawns the bundled host binary per capture (`runtime.sendNativeMessage`); the
  host validates the payload and **atomically writes** it (tmp + rename, one uniquely
  named file per capture) into the **capture inbox**, then acks. Size limits are a
  non-issue: extension→host allows 64 MiB; host→extension (1 MB cap) carries only acks.
- **App running** → the file watcher sees the new capture within ~1 s and drains it.
  **App closed** → the capture waits; the app drains the inbox on next launch. Either
  way the raw link is never lost, and no daemon or open port exists.
- The host locates the inbox via a pointer file the app maintains in a fixed app-data
  location (active graph). No graph configured → the host returns a typed error the
  extension surfaces ("open Reflect and pick a graph first").
- The host is a tiny dedicated Rust crate bundled as a Tauri sidecar (`externalBin`,
  signed/notarized with the app — verify [tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)
  in the code spike). **Not** a dual-mode main binary (browser kills the host on
  disconnect; single-instance forwarding would sever Chrome's stdio; stdout must stay
  protocol-pure).
- The desktop app **rewrites user-level host manifests on every launch**, for **detected
  browsers only** (Chrome channels, Chromium, Edge, Brave, Vivaldi, Opera, Arc — Arc has
  its own dir; Windows uses HKCU keys). Launch-time rewrite self-heals macOS app
  translocation and app moves. `allowed_origins` pins both the Chrome Web Store and Edge
  Add-ons extension IDs; dev builds share the store ID via the manifest `key` trick.
- **Fallback: loopback HTTP** only if native-messaging **packaging** proves unshippable
  (payload size is not a reason). If ever built, copy Joplin's model: loopback-only
  bind, `/ping` discovery, accept/reject pairing dialog minting a token, Host-header
  validation. Reject unauthenticated requests.
- **Not** a `reflect://` deep link (~2 KB practical URL budget; no structured payloads/
  retries) except as a URL-only last resort, and **never** a Reflect-hosted relay.

### Two-phase write: raw now, enrich later

Every capture lands in two phases so saving never waits on the network or AI:

1. **Raw entry (synchronous on drain):** the `[[Links]]` entry with URL/title/selection
   + provenance is written immediately. This is the durable save.
2. **Enrichment (asynchronous):** meta-tag scrape + AI description run later in the
   desktop app and **update the existing entry in place**. Deferred while the app is
   closed; retried on failure.

## Steps

1. **Chrome extension** (`apps/extension`, MV3): action button + `⌘⇧P` (or `⌘⇧K` if reserved)
   to capture the active tab's URL, title, user-selected text/highlights, and a
   screenshot (`captureVisibleTab`). Minimal UI: confirm + optional note. No keys, no AI.
   If the host is missing (app not installed) the extension explains + links the
   download, queues the capture in `chrome.storage`, and retries later. Status states
   are honest: **queued** (spooled into inbox or held in `chrome.storage` — the host
   cannot observe drain), **failed**. The extension never claims "saved" since it has
   no visibility into when the desktop app processes the spool.

2. **Native-messaging host (sidecar) + manifest registration.** Tiny Rust crate built in
   `beforeBuildCommand`, bundled via `externalBin`; pure-stdio discipline (log to
   stderr). Deserializes the capture envelope using typed Rust structs (generated from
   or manually mirroring the shared `@reflect/core` zod schema — Zod does not run in
   Rust; the TS schema is the single source of truth and the Rust structs must match it),
   writes the validated envelope + screenshot into the inbox
   atomically, acks **queued** on success or a typed error on failure. The host never
   observes drain, so it never acks "saved". Desktop app registers/rewrites
   manifests for detected browsers on every launch.

3. **Capture inbox + drain (core action).** A platform-agnostic capture envelope (zod)
   in `actions/capture` — `{url, title, selection?, screenshotRef?, note?, capturedAt,
   source}` — written identically by the desktop host today and by the future iOS
   share extension (app-group inbox) / Android intent handler. `drainCaptureInbox`
   executes these steps **in order**:
   1. Resolve the capture target (today's daily note, or a chosen note).
   2. **Privacy gate:** if the target is `private: true`, skip all enrichment and all
      outbound traffic (no URL fetch, no meta scrape, no screenshot/selection/note
      content sent out) — write the raw link only.
   3. Copy the screenshot from the spool into `assets/` (downscaled via `image`) and
      record the asset path. **The spool is not removed until assets are safely written.**
   4. Write the **raw** `[[Links]]` entry + provenance (phase 1 — the durable save).
   5. Remove the spool file.
   6. If not private: schedule async enrichment (phase 2).

   **Two triggers for drain** — the app calls `drainCaptureInbox` in both places:
   - **On launch:** scan the inbox directory for any files already present (captures
     that arrived while the app was closed); drain each before starting the watcher.
     The watcher only fires on *new* events and will miss pre-existing spool files.
   - **On watcher event:** drain the newly created file as it lands.

   Extend the Rust watcher (currently `daily/`+`notes/` `.md` only) to also report the
   inbox dir.

5. **Async enrichment (desktop-owned, never in the extension).** Runs after the raw
   entry is saved, queued + retried like any background job:
   - **Meta-tag scrape (no AI needed):** the app fetches the captured URL and extracts
     `<title>`, meta description, and OpenGraph tags (`og:title`, `og:description`,
     `og:image`, site name) to enrich the entry.
   - **AI description (only when an AI connection is enabled, Plan 10):** feed the
     screenshot + URL + title + selection + scraped meta to the user's configured
     provider (e.g. OpenAI) to generate a short description of the website. Direct
     app→provider; obey the same provider/error/visibility rules as the copilot.
   - Enrichment **patches only the captured entry** (located via provenance/URL); if
     the user already edited or removed it, skip rather than clobber. Record the
     provider/model used in provenance.

6. **Write path (desktop-owned, executed inside drain step 3 above).** Default shape:
   - append a `[[Links]]` entry to **today's daily note** (Plan 06 append-under-heading);
   - create a **dedicated markdown note** when the capture has enough phase-1 content
     to be worth preserving (selection/highlights present, or a screenshot) — the
     description arrives later in phase 2 and is patched into the dedicated note then,
     not used to decide whether to create it;
   - write minimal **provenance** frontmatter/markdown: original URL, captured title,
     captured time, source = extension, screenshot asset path (already written by drain
     step 3.3), selection/highlights, and (after enrichment) the AI provider/model used.
   Then reindex (Plan 04). **Dedup:** a re-capture is detected when the same URL already
   has an entry in today's `[[Links]]` section (same day, same note). In that case the
   existing entry is updated in place — enrichment/provenance/screenshot are refreshed,
   not duplicated. A capture on a *different day*, or into a *different note*, or with a
   *different selection* always creates a new entry. URL alone is not the dedup key when
   the target note or day differs.

7. **Errors + retries.** Reviewable failures (offline, no key, provider error). The
   extension surfaces queued/failed; the raw link is always saved even if
   enrichment fails; enrichment retries on next launch/online.

8. **Tests.** Envelope schema validation; spool-drain round-trip including the
   **app-closed** path (file written with no app, drained on next start);
   private-target path writes raw link with **zero** outbound traffic (no URL fetch, no
   AI); enrichment updates the raw entry in place with description + meta + provenance;
   enrichment skips an edited/removed entry; screenshot lands in `assets/` with a
   relative link; dedup updates in place.

## Key decisions / contracts

- **Desktop owns all writes, AI, and keys; the extension only captures + forwards.**
- **The native-messaging host is a spooler; the capture inbox is the IPC.** Capture
  works with the app closed; no socket, no port, no daemon.
- **Two-phase write:** raw entry saved synchronously on drain; meta scrape + AI
  description run asynchronously and update in place — never blocking the save, never
  running in the extension.
- **Manifests are rewritten every app launch, for detected browsers only.**
- **The capture envelope + `drainCaptureInbox` are platform-agnostic** — the future
  iOS share extension and Android intent handler write the same envelope into their own
  inboxes (app-group container / direct), so mobile costs no rearchitecture.
- **Privacy check runs before enrichment**; private targets never hit the network —
  no meta fetch, no cloud AI.
- **Captures are normal markdown + assets with provenance**, indexed like any note.
- **Loopback HTTP only on packaging failure; deep links URL-only last resort; never a
  hosted relay.**

## Acceptance criteria

- With the extension installed, capturing a page appends a `[[Links]]` entry to today's
  daily note with the screenshot already saved under `assets/` (phase 1, synchronous),
  then asynchronously gains an AI description + scraped meta tags (phase 2).
- **Capturing with the desktop app closed** queues the capture; it lands (raw, then
  enriched) on next app launch (test-asserted).
- With no AI connection enabled, captures still get the raw entry + scraped meta tags;
  no provider call is made.
- Capturing into a `private: true` target saves the raw link with no outbound traffic
  (test-asserted).
- Enrichment failure still saves the raw link; the extension shows honest
  saved/queued/failed status.
- Re-capturing the same URL **on the same day into the same note with the same
  selection context** updates rather than duplicates; a different day, note, or
  selection always creates a new entry.
- `pnpm typecheck` + tests pass.

## Risks

- **Sidecar signing/notarization** — [tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)
  reports externalBin notarization failures; verify first in the code spike. Loopback
  fallback stays documented. (Registration itself is de-risked: user-level manifest
  writes, KeePassXC/Claude Desktop precedent — see the spike doc.)
- **Inbox discovery** — the host depends on the app-data pointer file (active graph,
  multi-graph switching, unwritable inbox). Keep the pointer format versioned + typed
  errors for every miss.
- **Async enrichment racing user edits** — the entry may be edited/moved before
  enrichment lands; patch only the located entry, skip otherwise (tested).
- **Privacy leakage via capture.** Same severity as Plan 10 — gate before enrichment +
  outbound-payload test.
- **Stale manifests after uninstall** point browsers at a missing binary ("failed to
  start native messaging host") — harmless but noisy; document cleanup in Plan 15
  packaging.
