# What leaves the device, and when

Reflect is local-first: your notes are markdown files in a folder you chose, the search
index is SQLite in `.reflect/` beside them, and **no Reflect-hosted server exists in any
path** — there is no product analytics and no account. Official release builds send
scrubbed WebView diagnostics to Sentry, and official iOS release builds also send scrubbed
native crash diagnostics. Every network call the app can make is listed here, with what it
carries.

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

- **Where:** the extension sends captures only to the local native-messaging host,
  which writes them into the selected graph's inbox. It stores no keys and makes no
  AI or network requests of its own. The desktop's enrichment requests are described below.
- **What:** manual captures include the URL, title, selection, optional annotation,
  screenshot and opted-in page text. A manual X capture can include the post text,
  author, quote and image URLs from the page. Optional automatic X capture observes
  new bookmark/like actions on X pages and records the corresponding post snapshot;
  it does not import activity history or read other sites in the background.
- **Permissions:** manual capture uses temporary active-tab access. Ongoing X access
  is optional, off by default, and requested when the user enables automatic capture.
  Turning it off or revoking permission stops admission of new automatic captures.
- **When:** manual saves, or explicit X actions while automatic capture is enabled.
  The local queue retries while the desktop is unavailable. It retains at most 50
  captures, dropping the oldest at capacity.
- **Ordinary page enrichment:** the desktop may request the captured URL for metadata.
  On Apple platforms it may ask LinkPresentation for a representative image when no
  screenshot exists. Requests go to the website and its redirects/subresources.
  BYOK AI enrichment follows the provider rules above.
- **X enrichment:** the desktop requests the captured post ID from
  `cdn.syndication.twimg.com` and downloads up to four image/preview URLs supplied by
  the page or response, usually from `pbs.twimg.com`. These requests disclose the
  post ID or media URL and the device's network address. User annotations are not
  sent to X, and X snapshots do not use an AI provider. Missing remote content leaves
  the captured page text and source links available locally.
- **Privacy:** capture and Daily privacy are checked before requests and again before
  using their results. A private Daily creates a private capture without enrichment.
  Remote media is initially an ordinary link, so opening that raw note does not
  automatically load its images. A privacy change stops subsequent requests and
  discards pending results; it cannot retract a request already started. Completed
  X notes are not refreshed by later automatic actions.

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

- **Where:** Sentry. The React/WebView SDK handles JavaScript exceptions; on iOS a
  native SDK handles host-process crashes, fully blocking main-thread hangs, watchdog
  terminations, and converted Apple MetricKit diagnostics — the failures that never
  reach the JavaScript layer, and that arrive in TestFlight with no usable stack.
- **What:** an allow-listed diagnostic containing the JavaScript exception class (or a
  fixed native failure category), sanitized stack locations, the app/build version, and
  whether the exception was marked handled. Native reports also carry non-identifying
  OS/device model, architecture, memory, storage, battery, and thermal facts, which are
  what distinguish a resource termination from a code defect. A small set of vetted
  JavaScript structural error messages that cannot contain document data is kept; every
  native exception value and all other exception text is redacted. JavaScript filenames
  and native loaded-image names are reduced to basenames.
- **Never collected:** request data, note content, note titles, graph paths, local
  filesystem paths, native source paths, frame variables, source context lines, thread
  names, breadcrumbs, console or Rust tracing output, session replay, performance
  traces and profiles, screenshots, view hierarchy, raw MetricKit payloads, and user
  identifiers. Sentry is also configured not to store the transport IP address with
  events.
- **When:** only when an official desktop or iOS release raises an uncaught JavaScript
  error, an unhandled promise rejection, or a caught/recoverable React error — and on
  iOS, the native failure categories above. The WebView SDK initializes only in official
  builds carrying the release DSN. The iOS native SDK initializes only in release
  configurations of the official `app.reflect.ios` bundle; debug builds compile the
  call out entirely, and forks run under their own bundle identifier and stay silent.
- **Operational safeguards:** Sentry's server-side and default scrubbers are enabled, IP
  address storage and server-side JavaScript source scraping are disabled, and explicit
  sensitive-field rules cover notes, graph paths, requests, and user identifiers. Private
  JavaScript source maps and native dSYMs are uploaded during official builds so stacks
  are readable; native symbol uploads exclude sources, and neither kind of symbol file
  ships as readable source in the app bundle.

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
| Browser capture | Local native host on disk | Stays on your machine | Manual save or opt-in X action |
| Capture metadata and preview | The captured website, via Reflect and Apple LinkPresentation | URL only; private captures are blocked | No (after an explicit capture) |
| X post enrichment | X syndication and captured image hosts | Post ID/media URL; private captures are blocked | After a manual save or opt-in automatic action |
| Contacts lookup | Nowhere (on-device OS store) | — (stays on your machine) | Yes (opt-in) |
| Exception diagnostics | Sentry | No — free-form messages and context are redacted | No (official releases) |
