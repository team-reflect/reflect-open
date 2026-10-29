# Plan 11 — Link Capture

> **Update (2026-07-05):** the deferred iOS share half landed: a `ShareExtension`
> target spools the same envelopes (plus non-URL text as `kind: append` captures) into
> the App Group inbox, and the mobile app relays + drains them on launch/foreground. See
> [the porting doc](../porting/reflect-mobile/share-extension.md).
>
> **Status (2026-06-14): Implemented** end-to-end: `apps/extension` (WXT MV3, popup +
> queue + ⌘⇧K), `apps/native-host` (`reflect-capture-host`, a second sidecar), the
> capture inbox + watcher carve-out, and the drain/enrichment services in
> `packages/core/src/capture/`. Two deliberate first-release narrowings:
> browser-manifest registration is **macOS-only** (Windows/Linux land with Plan 15), and
> there is **no settings UI** (registration is silent; the popup explains
> missing-app/missing-graph states). Every capture creates a dedicated
> `notes/capture-<stamp>.md` (screenshots are always taken, so the "enough phase-1
> content" condition below always holds) plus the daily `[[Links]]` backlink;
> enrichment status lives in the capture note's frontmatter
> (`captureStatus: pending | done | skipped`).

**Goal:** Launch-grade web capture: a Chrome extension hands URL/title/selection/
screenshot to the **installed desktop app** through a local **capture inbox**; the
desktop owns all writes, BYOK AI enrichment, and privacy, appending to today's daily
note. Capture works **even when the app is closed**: the raw link is spooled at once
and enriched later.

**Depends on:** Plan 02 (writes/assets), Plan 06 (append-to-today), Plan 10 (BYOK AI,
keychain, privacy).
**Unlocks:** the capture half of Reflect's daily-first spine.

**Architecture:** the extension lives in `apps/extension`; all durable writes,
enrichment, and privacy checks go through the desktop + `@reflect/core`. See
[Architecture & Conventions](architecture-conventions.md).

**Libraries:** WXT, `image` (Rust, screenshot downscale). See [Libraries](libraries.md).

## Scope

**In:** Chrome extension (URL, title, selection/highlights, screenshot), the
native-messaging host + capture inbox, desktop write path (daily `[[Links]]` entry +
optional dedicated note), screenshot assets, async enrichment (meta scrape + BYOK AI
description), provenance, privacy enforcement.
**Out:** Safari/iOS/Android share (later; the envelope + drain are deliberately
platform-agnostic so mobile reuses them), full article extraction / read-later, heavy
dedup.

## Architecture (inverted from V1: desktop owns writes)

V1 called a Reflect-hosted `link-description-api`. V2 must not. The **extension**
captures and forwards; it holds **no model keys** and makes **no AI calls**. The
**desktop app** owns writes, paths, assets, keychain, BYOK calls, and the `private: true`
check.

### Bridge: native messaging host as a spooler (chosen)

The host is a **spooler, not a relay**: it never talks to the running app; the inbox
*is* the IPC.

- Chrome spawns the host per capture; it validates the payload, **atomically writes**
  one uniquely named file into the inbox, and acks. Size is a non-issue (extension→host
  allows 64 MiB; host→extension's 1 MB cap carries only acks).
- **App running:** the watcher drains the capture within ~1 s. **App closed:** it waits
  for the next launch. The raw link is never lost, and no daemon or open port exists.
- The host finds the inbox through a pointer file the app keeps in a fixed app-data
  location (active graph). No graph → a typed error the extension surfaces ("open
  Reflect and pick a graph first").
- The host is a tiny dedicated Rust crate bundled as a signed Tauri sidecar (verify
  [tauri#11992](https://github.com/tauri-apps/tauri/issues/11992)). **Not** a dual-mode
  main binary: the browser kills the host on disconnect, single-instance forwarding would
  sever Chrome's stdio, and stdout must stay protocol-pure.
- The app **rewrites user-level host manifests on every launch**, for **detected
  browsers only** (Chrome channels, Chromium, Edge, Brave, Vivaldi, Opera, Arc with its
  own dir). The rewrite self-heals macOS app translocation and app moves.
  `allowed_origins` pins both the Web Store ID and the key-derived unpacked dev ID.
- **Fallback: loopback HTTP** only if native-messaging **packaging** proves unshippable
  (payload size is not a reason). If built, copy Joplin: loopback-only bind, `/ping`
  discovery, accept/reject pairing dialog minting a token, Host-header validation.
- **Not** a `reflect://` deep link (~2 KB practical URL budget, no structured payloads or
  retries) except as a URL-only last resort, and **never** a hosted relay.

### Two-phase write: raw now, enrich later

Saving never waits on the network or AI:

1. **Raw entry (synchronous on drain):** URL/title/selection + provenance. This is the
   durable save.
2. **Enrichment (asynchronous):** meta scrape + AI description later **update the entry
   in place**; deferred while the app is closed, retried on failure.

## Steps

1. **Chrome extension** (MV3): action button + shortcut captures URL, title, selection,
   and a screenshot. Minimal UI: confirm + optional note. If the host is missing, explain
   + link the download, queue in `chrome.storage`, retry later. Status is honest:
   **queued** or **failed**. The extension never claims "saved" because it cannot see
   when the app drains the spool.
2. **Native host + manifest registration.** Pure-stdio discipline (log to stderr). The
   host's typed Rust structs must match the shared `@reflect/core` zod envelope schema
   (zod does not run in Rust; the TS schema is the source of truth). It writes envelope
   + screenshot atomically and acks **queued** or a typed error.
3. **Capture inbox + drain.** One platform-agnostic envelope, written identically by the
   desktop host and the mobile share/intent handlers. Drain order:
   1. Resolve the target (today's daily note, or a chosen note).
   2. **Privacy gate:** a `private: true` target skips all enrichment and all outbound
      traffic (no URL fetch, no scrape, nothing sent out); write the raw link only.
   3. Copy the screenshot into `assets/` (downscaled). **The spool is kept until assets
      are safely written.**
   4. Write the raw entry + provenance (the durable save).
   5. Remove the spool file.
   6. If not private, schedule enrichment.

   **Two drain triggers:** on launch, drain files already present *before* starting the
   watcher (the watcher only sees new events and would miss them); then on each watcher
   event. The Rust watcher is extended to report the inbox dir.
4. **Async enrichment (desktop only):** meta scrape (`<title>`, description, OpenGraph,
   site name) needs no AI. The AI description runs only when an AI connection is enabled
   (Plan 10), direct app→provider, under the copilot's rules. Enrichment **patches only
   the captured entry**; if the user edited or removed it, skip rather than clobber.
   Provenance records the provider/model.
5. **Write path** (inside drain step 4):
   - append under `## [[Links]]` in **today's daily note**, resolving the existing
     `Links` note (aliases/renames included) or creating it safely;
   - create a **dedicated note** when phase-1 content is worth keeping (selection or
     screenshot). The later description is patched into it but does not decide whether
     to create it;
   - minimal **provenance**: URL, title, time, source, screenshot path, selection, and
     (after enrichment) provider/model.
   Then reindex. **Dedup:** the same URL already in today's `[[Links]]` section of the
   same note updates that entry in place. A different day, note, or selection always
   creates a new entry; URL alone is not the key.
6. **Errors + retries:** offline, no key, provider error are reviewable. The raw link is
   always saved; enrichment retries on next launch/online.
7. **Tests:** envelope validation; drain round-trip incl. the **app-closed** path;
   private target with **zero** outbound traffic; in-place enrichment; skip on edited
   entry; screenshot in `assets/` with a relative link; dedup.

## Key decisions / contracts

- **Desktop owns all writes, AI, and keys; the extension only captures + forwards.**
- **The host is a spooler; the inbox is the IPC.** Works with the app closed; no socket,
  port, or daemon.
- **Two-phase write:** raw on drain, enrichment async and in place, never in the
  extension.
- **Manifests are rewritten every launch, for detected browsers only.**
- **Envelope + drain are platform-agnostic**, so mobile needs no rearchitecture.
- **Privacy check runs before enrichment**; private targets never hit the network.
- **Captures are normal Markdown + assets with provenance**, indexed like any note.
- **Loopback HTTP only on packaging failure; deep links URL-only last resort; never a
  hosted relay.**

## Acceptance criteria

- A capture appears under `## [[Links]]` in today's daily note with the screenshot in
  `assets/` (phase 1), then gains an AI description + meta (phase 2).
- **With the app closed**, the capture lands (raw, then enriched) on next launch.
- With no AI connection, captures still get the raw entry + scraped meta; no provider
  call.
- A `private: true` target saves the raw link with no outbound traffic.
- Enrichment failure still saves the raw link; the extension shows honest
  saved/queued/failed status.
- Re-capturing the same URL on the same day into the same note with the same selection
  updates rather than duplicates.

## Risks

- **Sidecar signing/notarization:** tauri#11992 reports externalBin notarization
  failures; verify first. Loopback fallback stays documented. (Registration itself is
  de-risked: user-level manifest writes, KeePassXC/Claude Desktop precedent.)
- **Inbox discovery** depends on the pointer file (multi-graph switching, unwritable
  inbox): version the pointer format, typed errors for every miss.
- **Enrichment racing user edits:** patch only the located entry, else skip (tested).
- **Privacy leakage via capture:** same severity as Plan 10; gate before enrichment +
  outbound-payload test.
- **Stale manifests after uninstall** point browsers at a missing binary: harmless but
  noisy; document cleanup in Plan 15.
