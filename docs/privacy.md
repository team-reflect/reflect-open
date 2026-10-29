# What leaves the device, and when

Reflect is local-first: notes are markdown files in a folder you chose, and the search index is
SQLite in `.reflect/` beside them. **No Reflect-hosted server exists in any path**: there is no
product analytics and no account. Official release builds send scrubbed diagnostics to Sentry.
This file lists every network call the app can make, with what it carries.

The hard rule above all of it: **a note with `private: true` frontmatter never has its content
sent to any external service.** Code enforces this at every AI call site: the `CloudSafe` type
brand in `packages/core/src/ai/` cannot be built from a private note, and the flag is re-read
from disk at call time. Tests cover it.

## AI chat (off until you add a key)

- **Where:** directly to the provider whose key *you* added (OpenAI, Anthropic, Google, or
  OpenRouter). Reflect proxies nothing.
- **What:** your messages and configured system prompt (stored in the ordinary settings file,
  sent every turn), plus what the model's tools read from your graph: search snippets, note
  content, and note listings. Private notes are dropped from every tool result, and reading one
  returns a refusal. This cannot catch note content you paste into a message or the prompt.
- **When:** only while you use chat (⌘J). No background calls.

## Audio memos (off until you add a key)

- **Where:** directly to your configured providers. OpenAI or Google gets the recording for
  speech-to-text. A small text model (OpenAI, Anthropic, or Google) gets the fresh transcript to
  make the memo title and, with Transcription auto-format on, to add punctuation, paragraphs,
  and light Markdown.
- **What:** the audio and its transcript only. Existing note content is never read or sent, so
  recording works even when today's note is private. With auto-format off, the raw transcript
  is stored, and the title call still gets it.
- **When:** when you record a memo, and on retry for memos still awaiting transcription.

## Semantic search (off by default)

- Embeddings are computed **on-device** (bundled ONNX runtime, `all-MiniLM-L6-v2`) and stored
  in `.reflect/`. Note content never leaves the machine.
- Enabling it downloads the model (~90 MB) **from Hugging Face, once**. The request carries no
  user data.
- Not available on Intel Macs or iOS, which have no embedding runtime.

## Backup & sync (off until you connect)

- **Where:** the git repository you connect: GitHub, guided in-app (created **private** by
  default; public needs explicit confirmation), or any git host over SSH.
- **What:** the whole graph as git commits, **including** `private: true` notes. The flag blocks
  *services that read your content*. Backup is your own repository, and excluding private notes
  would silently lose them.
- **When:** after you connect, on the background cadence and on "Back up now".
- GitHub sign-in uses the OAuth device flow against `github.com`. The token is in the OS
  keychain.

## Browser capture (the Chrome extension)

- **Where:** nowhere on the network. The **Reflect Capture** extension hands each capture to a
  local native-messaging host (`reflect-capture-host`) that the desktop app registers. The host
  writes it to the capture inbox (`<graph>/.reflect/inbox/`), and the app drains it on next
  launch. The extension stores no keys and makes no network or AI calls of its own.
- **What:** the page you explicitly capture (toolbar button or ⌘⇧K): URL, title, current
  selection, a screenshot of the visible tab, and the extracted page text only when you tick
  "Capture page text". When enabled, X bookmark and like capture watch that request on x.com and
  save the post identifier and available snapshot locally. Bookmark capture defaults to on, like
  capture to off, each set separately in the extension options. Existing likes and native X app
  actions are not imported. Unliking does not remove content. A request can be saved even if X
  later rejects it. Unrelated browsing is not captured.
- **When:** when you capture a page, or do an enabled bookmark or like on x.com in this browser.
  Turning a setting off stops new captures; accepted ones stay queued. If the desktop app is not
  reachable, the capture waits in the extension's local storage and retries. It is never sent
  anywhere else meanwhile.
- After a capture lands, the app's rules apply. Enrichment may fetch the captured URL directly
  for page metadata. On macOS and iOS, when the capture has no screenshot, Reflect also asks
  Apple's LinkPresentation for one representative image. These requests go to the captured site
  (and redirects or subresources the OS picks), never through a Reflect server. The app re-reads
  the capture and daily note before and after each request, and `private: true` prevents the
  request or discards its result. The image is downscaled and stored as a local JPEG. BYOK AI
  enrichment follows the provider rules above.

## Apple Contacts (off by default)

- **Where:** nowhere on the network. The integration reads the **on-device macOS/iOS contacts
  store** behind the standard OS permission prompt. Lookups are live queries: nothing is
  mirrored into `.reflect/`, and Reflect never writes to Contacts.
- **What:** a note title or a meeting attendee's email is matched against your contacts. A
  match's name, email, and phone show on a suggestion card. They enter a note **only when you
  click Add**, and then follow the same rules as anything you type (including `private: true`
  and backup).
- **When:** only while the integration is on, and only for the note being viewed (or the meeting
  being added). Turning it off, in Settings or the OS privacy pane, stops all reads at once.

## Exception diagnostics (on in official release builds)

- **Where:** Sentry. The WebView SDK handles JavaScript exceptions. On iOS a native SDK handles
  host-process crashes, watchdog terminations, and Apple MetricKit diagnostics (including
  main-thread hangs): failures that never reach JavaScript and arrive in TestFlight with no
  usable stack.
- **What:** an allow-listed report: the JavaScript exception class (or a fixed native failure
  category), sanitized stack locations, the app version, and whether it was handled. Native
  reports add non-identifying OS/device model, architecture, memory, storage, battery, and
  thermal facts, which tell a resource termination from a code defect. A small set of vetted
  JavaScript structural messages that cannot contain document data is kept. All other exception
  text, and every native exception value, is redacted. Filenames and loaded-image names are cut
  to basenames.
- **Never collected:** request data, note content or titles, graph paths, filesystem or native
  source paths, frame variables, source context lines, thread names, breadcrumbs, console or
  Rust tracing output, session replay, performance traces and profiles, screenshots, view
  hierarchy, raw MetricKit payloads, user identifiers, and the transport IP address.
- **When:** only when an official desktop or iOS release raises an uncaught JavaScript error, an
  unhandled promise rejection, or a caught React error, plus the iOS native categories above.
  The WebView SDK starts only in official builds with the release DSN. The iOS native SDK starts
  only in release configurations of the official `app.reflect.ios` bundle. Debug builds compile
  it out, and forks run under their own bundle ID and stay silent.
- **Safeguards:** Sentry's server-side and default scrubbers are on, IP storage and server-side
  source scraping are off, and explicit sensitive-field rules cover notes, graph paths,
  requests, and user identifiers. Official builds upload private source maps and native dSYMs
  (without sources) so stacks are readable. No symbol file ships as readable source in the app.

## Housekeeping calls

- **API key validation:** adding a key sends one cheap authenticated probe to that provider. No
  content.
- **Update check:** the packaged app fetches `latest.json` from this repository's GitHub
  Releases on launch and every six hours, from the stable or beta feed to match the build. It
  downloads the update only when you ask to install, and verifies it against a public key
  compiled into the app. No user data is sent. Offline, the check fails silently.

## Secrets

API keys and tokens live in the **OS keychain only**: never in markdown, `.reflect/`, or git.
Deleting a provider in Settings deletes its keychain entry.

## Summary table

| Call | Destination | Carries note content? | Off by default? |
| --- | --- | --- | --- |
| AI chat | Your chosen provider | Yes; private-note tool reads are blocked | Yes (needs your key) |
| Audio transcription | Your chosen providers | No; only audio and its fresh transcript | Yes (needs your key) |
| Embeddings | Nowhere (on-device) | No | Yes (opt-in download) |
| Model download | Hugging Face | No | Yes (opt-in) |
| Backup | Your git repository | Yes, including private notes | Yes (needs connecting) |
| Key validation | The provider | No | Only when adding a key |
| Update check | GitHub Releases | No | On in packaged builds |
| Browser capture | Nowhere (local host on disk) | Stays on your machine | Only when you capture |
| Capture metadata and preview | The captured website, via Reflect and Apple LinkPresentation | URL only; private captures are blocked | No (after an explicit capture) |
| Contacts lookup | Nowhere (on-device OS store) | Stays on your machine | Yes (opt-in) |
| Exception diagnostics | Sentry | No; free-form messages and context are redacted | No (official releases) |
