# What leaves the device, and when

Reflect is local-first: your notes are markdown files in a folder you chose, the search
index is SQLite in `.reflect/` beside them, and **no Reflect-hosted server exists in any
path** — there is no telemetry, no analytics, and no account. Every network call the app
can make is listed here, with what it carries.

The one hard rule sits above all of it: **a note with `private: true` frontmatter never
has its content sent to any external service.** This is enforced in code at every AI
call site (the `CloudSafe` type brand in `packages/core/src/ai/` — content for a
provider cannot even be constructed from a private note, and the flag is re-read from
disk at call time), and it is covered by tests.

## AI chat (off until you add a key)

- **Where:** directly to the provider whose API key *you* added — OpenAI, Anthropic, or
  Google. Keys are bring-your-own; Reflect proxies nothing.
- **What:** your chat messages, plus what the model's tools read from your graph:
  search snippets, note content, and note listings. Private notes are dropped from
  every tool result, and reading one is refused outright — the model sees a refusal,
  not the content.
- **When:** only while you use chat (⌘J). No background calls.

## Audio memos (off until you add a key)

- **Where:** the transcription provider you configured (OpenAI or Google).
- **What:** the recorded **audio bytes only** — never any note content. The transcript
  is written locally. Because no note content is read, recording works even when
  today's note is private.
- **When:** when you record a memo, and on retry for memos still awaiting
  transcription.

## Semantic search (off by default)

- Embeddings are computed **on-device** (a bundled ONNX runtime; `all-MiniLM-L6-v2`)
  and stored in `.reflect/`. Note content never leaves the machine for embedding.
- Enabling it downloads the model (~90 MB) **from Hugging Face, once**. That request
  carries no user data; the model is cached locally afterwards.

## Backup & sync (off until you connect)

- **Where:** the git repository you connect — GitHub guided in-app (created **private**
  by default; a public repo requires explicit confirmation), or any git host over SSH.
- **What:** the whole graph as git commits — including notes marked `private: true`.
  The privacy flag blocks *services that read your content*; backup is your own
  repository, and excluding private notes from it would silently lose them.
- **When:** after you connect, on the background backup cadence and on "Back up now".
- GitHub sign-in uses the OAuth device flow against `github.com`; the token is stored
  in the OS keychain.

## Browser capture (the Chrome extension)

- **Where:** nowhere on the network. The **Reflect Capture** extension hands each
  capture to a local native-messaging host (`reflect-capture-host`) that the desktop
  app registers on your machine; the host spools it to the capture inbox on disk
  (`<graph>/.reflect/inbox/`) and the app drains it on next launch. **No Reflect-hosted
  server, no third party, and no other destination is ever contacted** — the extension
  stores no keys and makes no AI or network calls of its own.
- **What:** only the page you explicitly capture (toolbar button or ⌘⇧K) — its URL,
  title, your current text selection, a screenshot of the visible tab, and, only when
  you tick "Capture page text", the page's extracted text. Nothing is read in the
  background; the extension requests no broad host permissions and acts on the active
  tab only at the moment you trigger it.
- **When:** when you capture. If the desktop app isn't reachable yet, the capture is
  held in the browser's local extension storage and retried automatically until it
  spools — it is never sent anywhere else in the meantime.
- Once a capture lands in your graph, the desktop app's rules above apply unchanged:
  any BYOK AI enrichment of it honors `private: true`, and no content leaves the device
  except through the calls listed here.

## Apple Contacts (off by default)

- **Where:** nowhere on the network. Enabling the Contacts integration reads the
  **macOS/iOS contacts store on-device** (the same store System Settings governs),
  behind the standard OS permission prompt. There is no Reflect copy of your address
  book: lookups are live queries, nothing is mirrored into `.reflect/`, and Reflect
  never writes back to Contacts.
- **What:** a note title or a meeting attendee's email is matched against your
  contacts; a match's name, email, and phone are shown on a suggestion card. Contact
  details enter a note **only when you click Add**, at which point they are ordinary
  markdown you own — covered by the same rules as anything else you type (including
  `private: true` and backup).
- **When:** only while the integration is on, and only for the note being viewed (or
  the meeting being added). Turning it off — in Settings or in the OS privacy pane —
  stops all reads immediately.

## Housekeeping calls

- **API key validation:** adding a provider key sends one `GET /v1/models` to that
  provider to test it. No content.
- **Update check:** the packaged app fetches a release manifest (`latest.json`) from
  this repository's GitHub Releases on launch and every six hours. Stable builds check
  the latest stable release; beta builds check the beta feed. The app downloads the
  update archive only when you ask it to install. No user data is sent; payloads are
  verified against a public key compiled into the app before installing. Offline, the
  check fails silently and the app carries on.

## Secrets

API keys and tokens live in the **OS keychain only** — never in markdown, never in
`.reflect/`, never in git. Deleting a provider in Settings deletes its keychain entry.

## Summary table

| Call | Destination | Carries note content? | Off by default? |
| --- | --- | --- | --- |
| AI chat | Your chosen provider | Yes — never private notes | Yes (needs your key) |
| Transcription | Your chosen provider | No — audio bytes only | Yes (needs your key) |
| Embeddings | Nowhere (on-device) | — | Yes (opt-in download) |
| Model download | Hugging Face | No | Yes (opt-in) |
| Backup | Your git repository | Yes — including private notes | Yes (needs connecting) |
| Key validation | The provider | No | — (only when adding a key) |
| Update check | GitHub Releases | No | On in packaged builds |
| Browser capture | Nowhere (local host on disk) | — (stays on your machine) | — (only when you capture) |
| Contacts lookup | Nowhere (on-device OS store) | — (stays on your machine) | Yes (opt-in) |
