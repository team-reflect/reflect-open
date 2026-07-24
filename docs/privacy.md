# What leaves the device, and when

Reflect is local-first: your notes are markdown files in a folder you chose, the search
index is SQLite in `.reflect/` beside them, and **no Reflect-hosted server exists in any
path** — there is no product analytics and no account. Official release builds send
scrubbed WebView and native crash/hang diagnostics to Sentry. Every network call the app
can make is listed here, with what it carries.

The one hard rule sits above all of it: **a note with `private: true` frontmatter never
has its content sent to any external service.** This is enforced in code at every AI
call site (the `CloudSafe` type brand in `packages/core/src/ai/` — content for a
provider cannot even be constructed from a private note, and the flag is re-read from
disk at call time), and it is covered by tests.

## AI chat (off until you add a key)

- **Where:** directly to the provider whose API key *you* added — OpenAI, Anthropic,
  Google, or OpenRouter. Keys are bring-your-own; Reflect proxies nothing.
- **What:** your chat messages and configured system prompt, plus what the model's
  tools read from your graph: search snippets, note content, and note listings. The
  configured prompt is stored in the device's ordinary settings file and is sent with
  every chat turn. Private notes are dropped from every tool result, and reading one is
  refused outright — the model sees a refusal, not the content. That protection cannot
  identify note content you manually paste into a message or the configured prompt.
- **When:** only while you use chat (⌘J). No background calls.

## Audio memos (off until you add a key)

- **Where:** directly to your configured providers. OpenAI or Google receives the
  recording for speech-to-text. A small text model from your configured OpenAI,
  Anthropic, or Google provider receives the fresh transcript to create the memo
  title and, when Transcription auto-format is enabled, add punctuation, paragraphs,
  and light Markdown to the body.
- **What:** the recorded audio bytes and the transcript produced from that recording.
  Existing note content is never read or sent. The resulting Markdown is written
  locally. Because no note content is read, recording works even when today's note is
  private. Turn Transcription auto-format off in Settings to store the raw provider
  transcript; the title-generation call still receives that transcript.
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
  enrichment may request the captured URL directly to read page metadata. On macOS and
  iOS, Reflect also asks Apple's LinkPresentation framework for one representative
  image when the capture has no screenshot. These requests go to the captured website
  and any redirects or subresources selected by the operating system, never through a
  Reflect server. The app re-reads the capture and daily note before and after each
  request; `private: true` prevents the request or discards its result. A successful
  image is downscaled and stored as a local JPEG in the graph. Any BYOK AI enrichment
  then follows the provider rules above.

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

## Exception diagnostics (on in official release builds)

- **Where:** Sentry. The React/WebView SDK handles JavaScript exceptions; the iOS native
  SDK handles host-process crashes, main-thread hangs, watchdog terminations, and
  converted Apple MetricKit diagnostics.
- **What:** an allow-listed diagnostic containing the JavaScript exception category (or
  a fixed native failure category), sanitized stack locations, the app/build version,
  and whether the exception was marked handled. Native
  reports can also include non-identifying OS/device model, architecture, memory,
  storage, battery, and thermal facts needed to distinguish resource terminations. A
  small set of vetted JavaScript structural error messages that cannot contain document
  data is kept; every native exception value and all other exception text is redacted.
  JavaScript filenames and native loaded-image names are reduced to basenames; native
  source paths, frame variables, context lines, and thread names are removed. Raw
  MetricKit payloads are not attached.
- **Never collected:** request data, note content, note titles, graph paths, local
  filesystem paths, breadcrumbs, console or Rust tracing output, session replay,
  performance traces/profiles, screenshots, view hierarchy, and user identifiers.
  Sentry is also configured not to store the transport IP address with events.
- **When:** when an official desktop or iOS release raises an uncaught JavaScript error,
  an unhandled promise rejection, or a caught/recoverable React error; on iOS, also for
  the native failure categories above. Development and self-built apps without the
  release DSN do not initialize Sentry.
- **Operational safeguards:** Sentry's server-side and default scrubbers are enabled, IP
  address storage and server-side JavaScript source scraping are disabled, and explicit
  sensitive-field rules cover notes, graph paths, requests, and user identifiers. Private
  JavaScript source maps and native dSYMs are uploaded during official builds for readable
  stacks; sources are not included with native symbol uploads, and neither kind of symbol
  file is shipped as readable source in the app bundle.

## Local iOS diagnostic journal

- Reflect keeps the newest **128** closed, timestamped lifecycle markers in its local
  app-support directory: startup stages, frontend-ready, background/foreground,
  WebContent-process termination/reload outcome, and recovery-mode changes. A shared
  report adds the current app/build version. This is a separate typed journal, not a copy
  of console or Rust logs, so it cannot accept note data, filenames, paths, URLs,
  settings, or arbitrary error text. The directory is excluded from iCloud and device
  backups.
- The journal is not uploaded automatically. **Settings → About → Share diagnostics**
  creates the JSON only when you ask and opens the iOS share sheet. The repeated-crash
  recovery screen offers the same action before opening settings, iCloud storage, or the
  note graph.
- Three main-WebView terminations within five minutes enable sticky recovery mode. “Try
  opening notes” explicitly clears the termination burst and reloads the app; a corrupt
  or unreadable journal always fails open to normal startup.

## Housekeeping calls

- **API key validation:** adding a provider key sends one cheap authenticated probe to
  that provider to test it. No content.
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
| AI chat | Your chosen provider | Yes — private-note tool reads are blocked | Yes (needs your key) |
| Audio transcription | Your chosen providers | No existing note content; audio and its fresh transcript | Yes (needs your key) |
| Embeddings | Nowhere (on-device) | — | Yes (opt-in download) |
| Model download | Hugging Face | No | Yes (opt-in) |
| Backup | Your git repository | Yes — including private notes | Yes (needs connecting) |
| Key validation | The provider | No | — (only when adding a key) |
| Update check | GitHub Releases | No | On in packaged builds |
| Browser capture | Nowhere (local host on disk) | — (stays on your machine) | — (only when you capture) |
| Capture metadata and preview | The captured website, via Reflect and Apple LinkPresentation | URL only; private captures are blocked | No (after an explicit capture) |
| Contacts lookup | Nowhere (on-device OS store) | — (stays on your machine) | Yes (opt-in) |
| Exception diagnostics | Sentry | No — free-form messages and context are redacted | No (official releases) |
| Local iOS diagnostic journal | Nowhere unless you explicitly share it | No — closed lifecycle markers only | No (stored locally) |
