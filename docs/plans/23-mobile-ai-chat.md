# Plan 23 — Mobile AI Chat (iOS)

**Goal:** the desktop AI Chat (Plan 10: BYOK, tool-grounded, `private: true`
hard-blocked, durable history) on iOS as a first-class surface: a Chat tab that
streams answers grounded in the user's notes, with provider keys entered on the
device and stored in the iOS keychain. **Same engine, new shell:** no engine
changes, no new sync mechanism, no new privacy surface.

**Depends on:** Plan 10 (engine, CloudSafe gate, `chat_*` store), Plan 19 (mobile
shell), Plan 21/22 (sync + settings substrate).
**Unlocks:** mobile audio-memo transcription (BYOK keys on device), search-grounded
chat from the All tab (later wave), mobile summarize/rewrite when the desktop write
wave lands.

**Not in scope:** the write wave (deferred on desktop too); search-results-grounded
chat from the All tab (contract 2); semantic search on mobile (fastembed/ORT is
desktop-only); Android validation (rides along, untested); key *sync* between devices
(per-device by design); voice input beyond iOS keyboard dictation.

> **Status (2026-07-05): implemented (steps 0–5 + the step 6 simulator half).**
> Verified on the iPhone 17 Pro simulator: Chat tab renders, the CTA pushes Settings,
> the add-provider sheet swaps model lists per provider and takes key input. Owed on a
> physical device with a real key: the full streaming pass (send, stop, tool chips,
> private-note refusal, history restore) and the picker/HEIC attachment check.
>
> **Step 0 verdicts (2026-07-05, simulator): all PASS.** Product call: simulator
> verdicts are accepted for hardware, so the temporary spike code was deleted in-branch
> instead of held for a device re-run; the real-key device pass stands in (a real
> streamed answer is the streaming verdict; backgrounding it is the suspension one).
> Streaming: 6/6 SSE chunks with ~400ms gaps through `providerFetch`, so
> tauri-plugin-http streams incrementally on iOS and no Rust fallback is needed.
> Keychain `ai-api-key:*` round-trip PASS. Chat store survives relaunch PASS.
> Backgrounding mid-stream: the request lives in the Rust process and survived (60/60
> chunks, ~11s gap while backgrounded, buffered chunks flushed on foreground; no abort,
> no hang; long suspensions still settle through the engine's error path).

## Where we stood

Reused unchanged:

- **The chat engine** (`packages/core/src/ai/chat/`) is platform-neutral TS. The
  privacy gate is type-level and travels with the code, so mobile needs no new
  enforcement.
- **Persistence:** the `chat_*` tables ship in the shared index-schema crate, the Rust
  write commands are not desktop-gated, and the durable-tables rule (index wipes never
  touch `chat_*`) already binds mobile.
- **Secrets:** `keyring` backs onto the iOS keychain (validated on device in Plan 22).
- **Transport:** LLM calls ride `providerFetch` → `tauri-plugin-http`, so requests
  leave from Rust and webview CORS/ATS never applies. The HTTP capability grants have
  no platform filter, so they already apply on iOS (as for Plan 22's GitHub calls).
- **Session state:** `ChatProvider` imports nothing desktop-shaped and mounts in the
  mobile tree as-is.
- **Desktop UI, reuse verified:** the transcript components use only shared chat
  primitives, the shared router, and meowdown's `MarkdownView`, so they are
  mobile-safe. The input and history menu are dropdown/tooltip/keybinding heavy and get
  re-shelled. Key validation takes an injected fetch (pass `providerFetch`).
- **Shell behaviors for free:** the formatting toolbar renders nothing while no
  *editor* is focused, so a focused chat textarea hides the tab bar and pins the
  composer on the keyboard edge with no shell changes. `chat` is already a root route
  in the mobile stack: **no stack changes**.

**The gap:** no chat screen, tab, or composer on mobile, and, the part that makes chat
work at all, no way to configure a provider on the phone. Settings live in the **OS
config dir per device**, so desktop providers and their keychain keys do not exist on
the phone. Mobile must also not offer semantic search (the embed stand-in reports
`unsupported`).

## Contracts

1. **One engine, no forks.** Mobile mounts the existing provider and engine. Any
   behavior difference is a parameter, never a copied code path. Shells may differ;
   transcript semantics, persistence, and privacy may not.
2. **Chat is a fourth root tab**, the mobile form of desktop's "a conversation
   deserves the whole column": it survives tab switches and is one tap away. V1-mobile's
   "chat over the current search results" from the All tab is worth keeping *later*, as
   another entry that seeds the same session, not a different chat.
3. **Lexical-only, stated honestly.** Mobile always passes
   `semanticSearchEnabled: false`, regardless of the per-device setting, so
   `search_notes` runs lexical and its tool description says keyword search. Never rely
   on hybrid's degrade-on-error to absorb the missing embed runtime.
4. **Providers are configured per device.** No provider → a CTA to Settings → AI. Keys
   are validated on entry, stored only under `ai-api-key:<configId>` in the keychain,
   and shown afterward only as `keyHint`. No key export, sync, or storage in
   Markdown/Git/iCloud: Plan 10's rules verbatim.
5. **Streaming must be provably incremental on iOS** (step 0 gate). Buffered SSE is a
   blocker to fix (plugin fix or Rust-side streaming), not something to hide behind a
   spinner.
6. **The composer is not the note editor.** A plain textarea that never registers with
   the formatting-toolbar store, so existing keyboard rules work unmodified. A test
   asserts the toolbar stays absent while the composer is focused.
7. **Tab switches do not lose work.** Screens unmount on tab change. Attachments already
   live in the provider; the draft text (component-local on desktop) is lifted beside
   them, like the All tab's query. Scroll restores through the existing harness.

## Steps

0. **Device spikes (gate):** streaming granularity (multiple deltas before complete),
   keychain round-trip under `ai-api-key:*`, chat store round-trip across relaunch and
   an index clear, and backgrounding mid-stream (the turn settles via the error/abort
   path with partial text persisted, not a hang or lost turn).
1. **Mount the engine** in the mobile app tree. Forced-lexical (contract 3) rides the
   platform surface: the provider ANDs the semantic setting with "not the mobile app".
   Lift the composer draft into the provider (contract 7).
2. **Mobile chat screen:**
   - Header in the other tabs' idiom with New Chat and History. Reuse the transcript
     components; wiki-link taps push the stacked note route.
   - New composer: draft-bound textarea, send/stop button, **no Enter-to-send** (Enter
     inserts a newline on mobile; send is the button), image attachments via the iOS
     photo picker.
   - **Downscale attachments in the shared helper** (~1568 px long edge, JPEG). It
     encoded files verbatim, so a 12 MP photo as a base64 data URL would bloat the
     payload, the saved row, and webview memory. Fixing the shared helper fixes desktop
     too; no mobile fork.
   - Model picker and history as drawers; no-provider CTA (contract 4).
3. **Navigation:** a Chat tab with haptics like the others; no special double-tap (the
   transcript's jump-to-latest covers it). Tests: turns and the draft survive a tab
   round-trip.
4. **AI provider settings on mobile:** an "AI" group listing providers (name +
   `keyHint`, default marker), an add-provider drawer (pick → key → validate → default
   model), remove/set-default. All state transforms come from core; the sheet is the
   only new code.
5. **Dev harness + tests.** Dev-bridge chat write stubs over the in-memory index DB,
   mirroring the Rust semantics (Rust-assigned `seq`, upsert-by-id, cascade delete). The
   harness can stream for real only against Anthropic (browser CORS headers); fine for
   dev. jsdom tests cover render, send/stop, history, add-provider, the forced-lexical
   assertion, and the CTA. Core privacy payload tests already cover the engine; do not
   duplicate them.
6. **Device pass + ship:** key validate fail/success, stream + stop, tool chips in a
   multi-tool turn, private-note refusal, history after relaunch, delete, kill
   mid-stream → partial turn persisted, graph switch (iCloud ⇄ local) shows per-graph
   history, All/Tasks tab-bar regressions, TestFlight build.

## Acceptance criteria

- With no desktop history, a user adds an Anthropic or OpenAI key in Settings → AI
  (validated, keychain-stored, only the hint visible), opens Chat, asks about their
  notes, and sees a streamed answer with tool chips and tappable `[[wiki link]]`
  citations.
- `search_notes` on mobile is lexical even when the settings have
  `semanticSearchEnabled: true` (payload assertion).
- A `private: true` note never appears in results and `read_notes` returns the
  structured refusal; one mobile-mount integration test proves the wiring.
- Conversations persist per graph across relaunch and index rebuilds; the 6-hour idle
  cutoff and history behave as on desktop.
- The tab keeps conversation, draft, and scroll across switches; keyboard never
  overlaps tab bar/composer; the formatting toolbar never appears for the composer.
- The `?platform=ios` harness renders the chat screen end-to-end on the dev bridge.

## Risks

- **iOS streaming buffering** was the one real platform unknown (contract 5). If
  buffered, escalate to Rust-side streaming rather than ship a chat that "types" in one
  paragraph.
- **Backgrounding mid-stream:** iOS suspends the process; the abort/error path should
  persist the partial turn, and the notice copy should not blame the provider.
- **Lexical-only grounding cost:** may need more model round-trips (the step cap
  applies). Acceptable for v1; the later All-tab search-grounded entry is the
  mitigation, not mobile embeddings.
- **Attachment formats:** the picker can hand over HEIC; the canvas re-encode
  normalizes to JPEG only if WKWebView decodes it (it does). Verify on device; fallback
  is rejecting undecodable files with a notice.
- **Per-device settings surprise users** whose desktop provider is missing on the phone.
  The empty state says "keys stay on each device" in one line.
