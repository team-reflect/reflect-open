# Plan 23 — Mobile AI Chat (iOS)

**Goal:** the desktop AI Chat (Plan 10 — BYOK, tool-grounded, `private: true`
hard-blocked, durable history) on the iOS app as a first-class mobile surface:
a Chat tab that streams answers grounded in the user's notes, with provider
keys entered on the device and stored in the iOS keychain. **Same engine, new
shell** — no chat-engine changes, no new sync mechanism, no new privacy
surface.

**Depends on:** Plan 10 (chat engine, CloudSafe gate, `chat_*` store), Plan 19
(mobile shell: tabs, stack, keyboard bridge, settings primitives), Plan 21/22
(the sync + settings substrate the chat history rides beside).
**Unlocks:** mobile audio-memo transcription (BYOK keys on device), the
search-grounded chat entry from the All tab (the V1-mobile interaction, a
later wave), mobile AI actions (summarize/rewrite) when the desktop write wave
lands.

**Explicitly not in scope:** the write wave (patchsets, rewrite — deferred on
desktop too); search-results-grounded chat from the All tab (see decision 2);
semantic search on mobile (indexing strategy: fastembed/ORT is desktop-only);
Android-specific validation (rides along, untested); provider/key *sync*
between devices (keys are per-device by design); voice input beyond the iOS
keyboard's own dictation.

> **Status (2026-07-05): implemented (steps 0–5 + the step 6 simulator
> half).** Engine mounted (forced-lexical via the platform surface, draft
> lifted into the provider), Chat tab + screen + composer + history/model
> sheets, the Settings AI group with the shared add-provider flow
> (`use-add-ai-provider-submit.ts`, one hook two shells), attachment
> downscaling in the shared helper, dev-bridge chat/secrets stubs over
> `DevIndexDb`, and the jsdom suite. Verified on the iPhone 17 Pro
> simulator: Chat tab renders, the CTA pushes Settings, the add-provider
> sheet swaps model lists per provider and takes key input. Owed on a
> physical device with a real key: the full streaming pass (send, stop,
> tool chips, private-note refusal, history restore) and the picker/HEIC
> attachment check.
>
> **Step 0 verdicts (2026-07-05, iPhone 17 Pro simulator).** Product call
> (2026-07-05): the simulator verdicts are accepted for hardware too, so the
> TEMPORARY spike set (`spike-plan23.ts`, the `spike_log` command, the
> `127.0.0.1:8787` capability entry, the `mobile-app.tsx` hook) was deleted
> in-branch rather than held for a device re-run — the real-key device pass
> above stands in for the synthetic probes (a real streamed answer is the
> streaming verdict; backgrounding it mid-answer is the suspension one).
> The simulator verdicts:
> all PASS. Streaming granularity: 6/6 SSE chunks with ~400ms inter-chunk
> gaps through `providerFetch` — tauri-plugin-http streams incrementally on
> iOS, no Rust fallback needed. Keychain `ai-api-key:*` round-trip PASS.
> `chat_message_save` → relaunch → `loadChatMessages` PASS (row found across
> app restarts). Backgrounding mid-stream: the request lives in the Rust
> process and survived — 60/60 chunks, an ~11s gap while backgrounded, the
> buffered chunks flushing on foreground; no abort, no hang (long
> suspensions still settle through the engine's error path).

## Where we stand

**What already exists and is reused unchanged:**

- **The whole chat engine.** `streamChat` (`packages/core/src/ai/chat/stream-chat.ts`),
  the note tools + CloudSafe minting (`tools.ts`, `../checkers.ts`), context-window
  fitting, the transcript model (`transcript.ts`), and the store (`store.ts`)
  are platform-neutral TS in `@reflect/core`. The privacy gate is type-level
  and travels with the code — there is no new enforcement work on mobile.
- **Persistence.** `chat_conversations`/`chat_messages` (migration
  `crates/index-schema/migrations/0008_chat.sql`) ship in the shared
  index-schema crate, so the mobile `.reflect/index.sqlite` already has the
  tables. The Rust write commands (`db/chat_write.rs`:
  `chat_message_save`, `chat_conversation_delete`) are registered outside any
  `#[cfg(desktop)]` block, and reads go through the ordinary Kysely `db_query`
  bridge. The durable-tables rule (index wipes never touch `chat_*`) already
  binds mobile.
- **Secrets.** `secrets.rs` on `keyring` (`apple-native`) backs onto the iOS
  keychain; PR #483/Plan 22 validated the round-trip on device
  (`spike_mobile.rs::check_keychain`). `aiKeySecretName(configId)` is just a
  naming policy on top.
- **Transport.** LLM calls ride `providerFetch`
  (`apps/desktop/src/lib/provider-fetch.ts`) → `tauri-plugin-http`, so
  requests leave from the Rust side and webview CORS/ATS never applies. The
  plugin registers unconditionally and `capabilities/default.json` has no
  `platforms` filter — the OpenAI/Anthropic/Google/OpenRouter grants already
  apply on iOS (same argument that carried Plan 22's GitHub calls).
- **Session state.** `ChatProvider`
  (`apps/desktop/src/providers/chat-provider.tsx`) imports only
  platform-neutral things (graph/settings providers, core, `providerFetch`,
  query-client). Nothing in it is desktop-shaped; it can mount in the mobile
  tree as-is.
- **Desktop UI to mine — reuse verified, not assumed.** `chat-turn-list.tsx`,
  `chat-turn.tsx`, `chat-assistant-part.tsx`, `chat-tool-chip.tsx` import
  only shadcn chat primitives (`Bubble`/`Marker`/`Message`), the shared
  router, `useWikiLinkNavigation` (router-based, mobile-safe), and
  `MarkdownPreview` (meowdown `MarkdownView` — the editor stack mobile
  already ships). Nothing desktop-shaped in the transcript path.
  `chat-input.tsx` + `chat-history-menu.tsx` are dropdown/tooltip/keybinding
  heavy and get re-shelled. The settings side has `ai-providers-section.tsx` /
  `add-ai-provider-dialog.tsx` + `validateApiKey(provider, key, fetchFn)`
  (fetch injected — pass `providerFetch`) to mine for the mobile sheet.
- **Shell behaviors that come free.** `MobileFormattingToolbar` renders
  `null` while no *editor* is focused (the All-tab search field already
  depends on this) — so a focused chat textarea hides the tab bar and pins
  the composer on the keyboard edge with no shell changes. And
  `mobile-stack.tsx`'s `isStacked` lists only `note`/`settings`/`graphs`, so
  `{ kind: 'chat' }` is already a root route: **no stack changes**.
- **Mobile substrate.** Tab bar + stack (`mobile-tab-bar.tsx`,
  `mobile-stack.tsx`), `--keyboard-height` layout (`use-keyboard.ts`,
  `mobile-shell.tsx`), vaul Drawer idiom, inset-grouped `settings-list.tsx`
  rows, and the `?platform=ios` browser harness with the in-memory dev bridge.

**The gap:** the mobile tree has no chat case (`mobile-screen.tsx` falls back
to Daily for `{ kind: 'chat' }`), no chat tab, no mobile composer, and — the
part that makes chat *work* at all — no way to configure an AI provider on the
phone: the settings document lives in the **OS config dir per device**
(`src-tauri/src/settings.rs`), so desktop-configured providers and their
keychain keys do not exist on the phone. Mobile also must not offer semantic
search: `embed_mobile.rs` stubs fail loudly by design.

## Contracts

1. **One engine, no forks.** Mobile mounts the existing `ChatProvider` and
   calls the same `streamChat`/store/tools. Any behavior difference is a
   parameter (see 3), never a copied code path. UI shells may differ;
   transcript semantics, persistence, and privacy may not.
2. **Chat is a fourth tab.** Desktop's product call (Plan 10 revision) was
   "a conversation deserves the whole column" — the mobile equivalent of the
   dedicated `chat` route is a root tab (`MobileTab = 'daily' | 'all' |
   'tasks' | 'chat'`), not a stacked card: the conversation survives tab
   switches (provider state already guarantees this) and is one tap away.
   The V1-mobile "chat over the current search results" entry from the All
   tab is real and worth keeping *later* — as an additional entry point that
   seeds the same session, not a different chat.
3. **Lexical-only, stated honestly.** Mobile passes
   `semanticSearchEnabled: false` into `streamChat` unconditionally —
   regardless of the (per-device) setting — so `search_notes` runs
   `mode: 'lexical'` and the tool description tells the model it's keyword
   search. Never rely on hybrid's degrade-on-error to absorb the missing
   embed runtime.
4. **Providers are configured per device.** The Chat tab with no configured
   provider renders a CTA to Settings → AI. Keys are validated on entry
   (`validate-key.ts`, over `providerFetch`), stored only under
   `ai-api-key:<configId>` in the iOS keychain, and surfaced afterward only
   as `keyHint`. No key export, no key sync, nothing in markdown/Git/iCloud —
   the Plan 10 rules verbatim.
5. **Streaming must be provably incremental on iOS** (spike gate, step 0).
   If `tauri-plugin-http` buffers SSE bodies on iOS, that is a blocker to
   resolve (plugin fix or Rust-side streaming command), not something to
   paper over with a spinner.
6. **The composer is not the note editor.** Chat input is a plain textarea
   that never registers with the formatting-toolbar store — the shell's
   existing keyboard rules then do the right thing unmodified (toolbar null,
   tab bar hidden, composer on the keyboard edge). No new keyboard machinery;
   a test asserts the toolbar stays absent while the composer is focused.
7. **Tab switches don't lose work.** Screens unmount when the tab changes.
   Queued attachments already live in `ChatProvider`; the composer draft
   text is `ChatInput`-local on desktop and must be lifted beside them (the
   same lift the shell already does for the All tab's query). Transcript
   scroll restores through the existing `use-scroll-restore` harness.

## Steps

0. **Device spikes (gate for everything else).** On simulator + one physical
   device, log `[plan23-spike] PASS/FAIL`:
   - **Streaming granularity:** stream a real provider response through
     `providerFetch`; assert multiple `text-delta` events arrive before
     `complete` (contract 5).
   - **Keychain:** `secret_set/get/delete` under an `ai-api-key:*` name
     (re-run of the Plan 22 spike with our names).
   - **Chat store:** `chat_message_save` → relaunch → `loadChatMessages`
     round-trip on the mobile index DB, including after an `index_clear`.
   - **Backgrounding mid-stream:** background the app while streaming;
     confirm the turn settles as the engine's error/abort path (partial text
     + notice persisted), not a hang or a lost turn.

1. **Mount the engine.** `ChatProvider` into `mobile-app.tsx` (inside
   `RouterProvider`/`SyncProvider`, beside `CaptureProvider`) — it needs only
   the graph/settings providers, both already above it. Forced-lexical per
   contract 3 rides the platform surface (`mobile-root.tsx` already calls
   `setPlatformSurface({ touchEditor: true, mobileApp: true })`; the provider
   ANDs `settings.semanticSearchEnabled` with `!mobileApp`). Lift the
   composer draft into the provider (contract 7). Verify
   `loadChatGraphContext` (pure `db_query` stats) returns on mobile.

2. **Mobile chat screen.** `apps/desktop/src/mobile/screens/chat.tsx`:
   - Header in the other tabs' idiom (safe-area aware): New Chat and History
     actions. Reuse `ChatTurnList`/`ChatTurn`/`ChatAssistantPart`/
     `ChatToolChip` (imports verified mobile-safe) with the touch CSS
     resets; wiki-link taps in settled markdown push the stacked note route
     via the shared router. Scroll restore per contract 7.
   - New `MobileChatComposer`: textarea bound to the provider-held draft,
     send/stop button, no Enter-to-send footgun (Enter inserts a newline on
     mobile; send is the button), attachment entry via
     `<input type="file" accept="image/*">` (the iOS photo picker) feeding
     the existing `attachImages`.
   - **Downscale attachments in `toChatAttachment`** (canvas resize to a
     ~1568 px long edge, JPEG). Today it encodes the file verbatim; a 12 MP
     camera photo as a base64 data URL would bloat the provider payload, the
     saved row, and webview memory. This fixes desktop too — do it in the
     shared helper, not a mobile fork.
   - Model picker and conversation history as vaul Drawers (mine
     `chat-history-menu.tsx` for the list/delete semantics; use
     `settings-list.tsx` row primitives inside the sheets).
   - No-provider state: CTA that pushes the settings card (contract 4).

3. **Navigation.** Add `case 'chat'` to `mobile-screen.tsx`, extend
   `MobileTab` + `mobile-tab-bar.tsx` + the shell's tab⇄route mapping with a
   Chat tab (haptics like the others; no special double-tap — the transcript
   scroller's own jump-to-latest button covers it). `mobile-stack.tsx` needs
   **no change** — `chat` is already a root route by `isStacked`'s
   definition. Tests: turns survive a tab round-trip; the lifted draft
   survives a tab round-trip.

4. **AI provider settings on mobile.** In `screens/settings.tsx`, a new "AI"
   `SettingsGroup`: one row per configured provider (name + `keyHint`,
   default marker), an "Add provider…" action row opening an add-provider
   Drawer (provider pick → key entry → `validate-key` over `providerFetch` →
   default model), and remove/set-default actions. All state transforms come
   from core (`provider-config.ts`); the sheet is the only new code. Settings
   keys ripple into tests — expect the usual test fixture updates.

5. **Dev harness + tests.**
   - Dev bridge: add `chat_message_save`/`chat_conversation_delete` cases
     writing into `DevIndexDb` — it already applies the real index-schema
     migrations (including `0008_chat.sql`), so the existing Kysely reads
     (`listChatConversations`/`loadChatMessages`) work in the harness once
     the write commands land there. Mirror `chat_write.rs` semantics
     (Rust-assigned `seq`, upsert-by-id, cascade delete). Note the harness
     can stream for real only against Anthropic (browser CORS headers) —
     fine for dev.
   - jsdom tests: chat screen render + turn folding, composer send/stop,
     history drawer open/load/delete, settings add-provider flow
     (mock `validate-key`), forced-lexical assertion (mobile mount passes
     `semanticSearchEnabled: false` even with the setting true), and the
     no-provider CTA.
   - Core privacy payload tests already cover the engine; do not duplicate.

6. **Device pass + ship.** Manual matrix on a physical phone: add a key
   (validate fail + success), stream + stop, tool chips render during a
   multi-tool turn, private-note refusal shows, history restore after
   relaunch, delete conversation, kill mid-stream → partial turn persisted,
   graph switch (iCloud ⇄ local) shows the right per-graph history, All/Tasks
   regressions (tab bar), TestFlight build.

## Acceptance criteria

- On a phone with no desktop history: user adds an Anthropic or OpenAI key in
  Settings → AI (validated; stored in the iOS keychain; only the hint visible
  afterward), opens the Chat tab, asks a question about their notes, and
  watches the answer stream in with tool chips and tappable `[[wiki link]]`
  citations.
- `search_notes` on mobile is lexical: tool description says keyword search,
  and a payload assertion shows `mode: 'lexical'` even when the settings
  document has `semanticSearchEnabled: true`.
- A `private: true` note never appears in results and `read_notes` returns
  the structured refusal — existing core tests stay green, one mobile-mount
  integration test proves the wiring.
- Conversations persist per graph across relaunch and index rebuilds; the
  6-hour idle cutoff and history drawer behave as on desktop.
- Chat tab keeps its conversation, half-typed draft, and scroll position
  across tab switches; keyboard shows/hides without tab-bar/composer overlap;
  formatting toolbar never appears for the composer.
- `pnpm check` + targeted tests pass; the `?platform=ios` harness renders the
  chat screen end-to-end on the dev bridge.

## Risks

- **iOS streaming buffering** — the one genuinely unknown platform behavior
  (contract 5). Spike first; if buffered, escalate to a Rust-side streaming
  command rather than shipping a chat that "types" in one paragraph.
- **Backgrounding mid-stream.** iOS suspends the process; the engine's
  abort/error settle path should already persist the partial turn — the spike
  proves it, and the notice copy should not blame the provider for it.
- **Token/latency cost of lexical-only grounding.** Lexical `search_notes`
  may need more model round-trips to find the right notes (`MAX_STEPS = 12`
  cap applies). Acceptable for v1; the All-tab search-grounded entry (later
  wave) is the mitigation, not mobile embeddings.
- **Attachment format quirks.** Downscaling (step 2) handles size, but the
  iOS photo picker can hand over HEIC; the canvas re-encode normalizes to
  JPEG only if the webview decodes HEIC (WKWebView does). Verify in the
  device pass; the fallback is rejecting undecodable files with a notice.
- **Settings-document divergence.** Provider entries are per-device on
  purpose, but users will ask why their desktop provider isn't on the phone.
  The empty-state copy should say "keys stay on each device" in one line
  (copy stays sparse).
