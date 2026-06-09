# Plan 11 — Link Capture

**Goal:** Launch-grade web capture: a Chrome extension hands URL/title/selection/
screenshot to the **installed desktop app** over a local bridge; the desktop app owns all
writes, BYOK AI enrichment, and privacy — appending to today's daily note.

**Depends on:** Plan 02 (writes/assets), Plan 06 (append-to-today), Plan 10 (BYOK AI +
keychain + privacy).
**Unlocks:** the capture half of Reflect's daily-first spine.

**Architecture:** the extension lives in `apps/extension`; all durable writes, AI
enrichment, and privacy checks go through `apps/desktop` + `@reflect/core`
(`actions/capture`). See [Architecture & Conventions](architecture-conventions.md).

**Libraries:** WXT (Chrome extension framework, TS), `image` (Rust, screenshot
downscale). See [Libraries](libraries.md).

## Scope

**In:** Chrome extension (capture active URL, title, selection/highlights, screenshot),
the extension→desktop bridge, desktop write path (daily-note `[[Links]]` entry + optional
dedicated note), screenshot assets, BYOK AI description, provenance frontmatter, privacy
enforcement.
**Out:** Safari/iOS share (later), full article extraction / read-later (deferred),
dedup-heavy clipping (basic dedup only).

## Architecture (inverted from V1: desktop owns writes)

V1 called a Reflect-hosted `link-description-api`. V2 must not. Instead:

- The **extension** captures and forwards; it stores **no model keys** and makes **no AI
  calls**.
- The **desktop app** owns durable writes, file paths, asset storage, keychain access,
  BYOK AI calls, and the `private: true` check.

### Bridge: native messaging first, loopback HTTP fallback

- **First spike: Chrome native messaging** — the official extension↔native-app channel;
  no exposed local port. A small native-messaging host binary (bundled with the app)
  relays the capture to the running desktop app (local IPC).
- **Fallback: loopback HTTP** on `127.0.0.1` if screenshot payload size / streaming /
  packaging make native messaging awkward.
- **Not** a `reflect://` deep link (too limited for screenshots/structured payloads/
  retries) except as a URL-only last resort, and **never** a Reflect-hosted relay.
  Choose in a short spike (reuses Plan 01's spike discipline).

## Steps

1. **Chrome extension** (`extension/`, MV3): action button + `⌘⇧P` (or `⌘⇧K` if reserved)
   to capture the active tab's URL, title, user-selected text/highlights, and a
   screenshot (`captureVisibleTab`). Minimal UI: confirm + optional note. No keys, no AI.

2. **Native-messaging host + desktop receiver.** Register the host manifest on install;
   host forwards the capture payload to the desktop app. Desktop validates the payload
   with zod, queues it, and acknowledges (so the extension can show success/retry).

3. **Privacy gate first.** Resolve the capture target (today's daily note, or a chosen
   note). If the target is `private: true`, **save the raw link locally without any cloud
   AI** (no URL fetch, screenshot, selection, or note content sent out). Otherwise proceed
   to enrichment.

4. **BYOK enrichment.** Using the user's key (Plan 10), generate a short description from
   URL + title + screenshot + selected text. Direct app→provider; obey the same provider/
   error/visibility rules as the copilot.

5. **Write path (desktop-owned).** Default shape:
   - append a `[[Links]]` entry to **today's daily note** (Plan 06 append-under-heading);
   - create a **dedicated markdown note** when the capture is rich (description +
     highlights + screenshot worth preserving);
   - store screenshots under `assets/` with relative links (Plan 02);
   - write minimal **provenance** frontmatter/markdown: original URL, captured title,
     captured time, source = extension, screenshot asset path, selection/highlights, and
     the AI provider/model used.
   Then reindex (Plan 04). Basic dedup: re-capturing the same URL updates rather than
   duplicates.

6. **Errors + retries.** Reviewable failures (offline, no key, provider error). The
   extension surfaces success/queued/failed; the raw link is always saved even if
   enrichment fails.

7. **Tests.** Payload schema validation; private-target path writes raw link with **zero**
   outbound AI; enrichment path produces description + provenance; screenshot lands in
   `assets/` with a relative link; dedup updates in place.

## Key decisions / contracts

- **Desktop owns all writes, AI, and keys; the extension only captures + forwards.**
- **Native messaging is the first bridge**, loopback HTTP the fallback; no hosted relay.
- **Privacy check runs before enrichment**; private targets never hit cloud AI.
- **Captures are normal markdown + assets with provenance**, indexed like any note.

## Acceptance criteria

- With the extension installed, capturing a page appends a `[[Links]]` entry to today's
  daily note with an AI description + screenshot under `assets/`.
- Capturing into a `private: true` target saves the raw link with no outbound AI
  (test-asserted).
- Enrichment failure still saves the raw link; the extension shows status.
- Re-capturing the same URL updates rather than duplicates.
- `pnpm typecheck` + tests pass.

## Risks

- **Native messaging packaging/registration** across install paths. De-risk in the spike;
  keep the loopback fallback ready.
- **Screenshot payload size** over the bridge. Compress/downscale; fall back to HTTP if
  native messaging limits bite.
- **Privacy leakage via capture.** Same severity as Plan 10 — gate before enrichment +
  outbound-payload test.
