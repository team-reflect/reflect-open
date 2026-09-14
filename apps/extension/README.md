# Reflect Capture (Chrome extension)

Save the page you're reading into Reflect: ⌘⇧K saves immediately with default
settings, including the stored page-text preference, while the toolbar button
opens the capture popup for an optional note. Captures include the page URL,
title, selection, screenshot, and optional page text when Chrome allows them,
then hand off to the **installed desktop app** through a local native-messaging
host. No Reflect-hosted services are involved, and capture works even while the
app is closed: the host spools into the graph's capture inbox
(`<graph>/.reflect/inbox/`), and the app drains it on next launch.
[Plan 11](../../docs/plans/11-link-capture.md) is the design doc.

Install the published extension from the
[Chrome Web Store](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd).

## Architecture in one breath

popup → `chrome.storage` queue → background `sendNativeMessage` →
`reflect-capture-host` (Tauri sidecar, registered by the desktop app on every
launch) → capture inbox → desktop drain (`@reflect/core` `actions/capture`):
raw note + daily `## [[Links]]` entry now (resolving or creating that category
note), meta-scrape + BYOK AI title + description async. The extension stores no
keys and makes no AI or network calls; its only honest status is **queued** — it
cannot observe the desktop drain.

## Develop

```bash
pnpm --filter @reflect/extension dev     # wxt dev server (hot-reloads a loaded extension)
pnpm --filter @reflect/extension build   # production build → .output/chrome-mv3
pnpm --filter @reflect/extension test    # vitest over lib/
```

Load a build via `chrome://extensions` → Developer mode → **Load unpacked**.
The dev server does not open Chrome for you: load `.output/chrome-mv3-dev` once,
and it hot-reloads from then on. Prefer `pnpm … dev` for development, since it
always keeps the pinned `key`. You can also load the `pnpm … build` output
(`.output/chrome-mv3`), but **do not load the `pnpm zip` output**: the store
artifact omits `key`, so it loads under a random ID the host won't allowlist.

For the native hop to work, run the desktop app once (it writes the host
manifests for detected browsers and the active-graph pointer file), then
restart Chrome so it re-reads the manifests.

### X capture diagnostics (development only)

Open an X post permalink in the same Chrome profile in which you can read it.
After loading or reloading the dev extension, refresh the X tab so its
`document_start` observer sees the page's responses. Expand long posts, open the
Reflect popup, and use **X capture probe (development)**. The post ID is prefilled
from the permalink. Keep the popup open until the probe finishes.

The probe reuses `@post-embed/exporter/x` in the MAIN world, with a 200-entry
in-memory cache, raw payload retention disabled, and broadcasts disabled. An
ISOLATED content script queries one ID over the exporter bridge. The worker
validates the returned snapshot and target URL again before reading media.
Public and protected posts use the same path; there is no public proxy fallback.

The popup shows main/quoted text, truncation flags, per-resource read outcomes,
video format counts, byte signatures, and a document token. It reads avatars,
photos, posters, and the highest-bitrate MP4 for each video or GIF. HLS-only
videos are reported as unsupported, retaining their text and poster diagnostics.
A missing source, HTTP failure, and unsupported HLS are separate outcomes.

This is a probe, not an archive operation. Media streams are consumed and
discarded, retaining at most a 32-byte prefix per resource. The diagnostic budget
is 64 MiB and 120 seconds per resource. A budget failure does not mean the source
cannot be archived. Closing the popup loses its report; reopening it does not
resume a probe. The worker rejects a second probe for a tab while its first is
still running. No probe snapshot is queued or sent to the native host.

Only development builds register these content scripts and add media permissions
for `pbs.twimg.com` and `video.twimg.com`. Production/store builds exclude the
scripts, diagnostic UI, worker handler, and these extra permissions. The worker
accepts probe requests only from the extension popup, rejects incognito and
non-permalink tabs, checks every media URL against the allowlist, and rejects
redirects. `credentials: include` uses Chrome's normal cookie rules; it does not
guarantee that every resource will be accessible.

To build the diagnostic variant without running a server:

```bash
pnpm --filter @reflect/extension exec wxt build --mode development
```

Load `.output/chrome-mv3-dev` from `chrome://extensions`. Synthetic unit fixtures
cover public/protected wrapper parity, post IDs, navigation during lookup,
untrusted media origins, stream budgets, and partial failures. CI builds both
production and development variants. Real authenticated X verification remains
manual, because synthetic tests cannot establish cookie/CDN behavior:

| Scenario | Required result |
| --- | --- |
| Public/protected short text, expanded long text | Correct body; truncated source visibly flagged |
| Main and quoted photos, MP4, GIF | Actual nonzero bytes for each selected supported resource |
| HLS-only / absent source | `hls-only` / `no-source`, with separate format counts |
| Old tab without observer | Refresh/reopen retry instruction |
| SPA navigation or tab close during lookup | Failure instead of a different post's snapshot |
| Extension reload, then page refresh | One current listener/observer, no duplicated results |
| bfcache back/forward navigation | Restored document can still answer a probe |

Record only aggregate counts, outcome categories, and whether the worker reader
worked. Do not commit real protected text, media URLs, screenshots, or cookies.
A passing synthetic test/build does not complete the authenticated acceptance
matrix. This change does not yet establish that matrix's results.

### Troubleshooting: "Install Reflect to finish saving…" while Reflect is installed

That message is the `no-host` state — Chrome could not reach (or was not
allowlisted by) the native-messaging host. Check, in order:

1. **The extension's ID.** In `chrome://extensions`, the card must read either
   `ccabifmooehighoonjeiololjfofkhkd` for the Chrome Web Store listing or
   `dlbliojklpickgimjdmjjdnbjdiomjik` for an unpacked development build. Any
   other ID means you loaded a **keyless** local build (typically
   `.output/chrome-mv3` right after `pnpm zip`, which builds with
   `WXT_STORE_BUILD=true`). Rebuild with `pnpm … dev` or `pnpm … build`, then
   **Reload** the extension. The host allowlists only the store and pinned dev
   IDs, so a wrong ID is rejected as "forbidden" → this message.
2. **The desktop app has run at least once** on this machine, so it has written
   `~/Library/Application Support/<browser>/NativeMessagingHosts/app.reflect.capture.json`.
   If Chrome was already open when that file appeared, restart Chrome.
3. **A graph is selected** in the app. The `no-graph` variant of this message
   ("Open Reflect and pick a graph first") means the host ran but has no active
   graph to spool into.

The capture is never lost while held — it stays queued and retries automatically
once the host is reachable.

## The unpacked ID is pinned — and the store ID is not the same

`wxt.config.ts` carries a public `key`, which fixes the extension ID to
`dlbliojklpickgimjdmjjdnbjdiomjik` for **unpacked** loads — `wxt dev`, CI, and a
`wxt build` you load by hand. The desktop app's host manifests
(`apps/desktop/src-tauri/src/capture.rs`, `EXTENSION_ORIGINS`) allowlist exactly
this origin, so during development the native hop works. Changing the key without
updating that constant silently breaks it. The private half of the key is
deliberately discarded; unpacked loads only need the public key.

**The Chrome Web Store does not use this key.** It rejects a `key` field in the
uploaded package (`key field is not allowed in manifest`) and minted the live
listing ID `ccabifmooehighoonjeiololjfofkhkd`. So:

- The store artifact must **omit** `key`. `pnpm zip` sets `WXT_STORE_BUILD=true`,
  which drops it; every other build keeps it. (`manifest-key.test.ts` still pins
  the dev key against `EXTENSION_ORIGINS`.)
- `apps/desktop/src-tauri/src/capture.rs` must keep both the store ID and the
  pinned dev ID in `EXTENSION_ORIGINS`, or the native hop will fail for one of
  the two install modes.

To derive an ID from a key (if it ever has to change):

```bash
openssl genrsa 2048 > key.pem
openssl rsa -in key.pem -pubout -outform DER | base64        # manifest "key"
openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 \
  | head -c 32 | tr '0123456789abcdef' 'abcdefghijklmnop'    # extension ID
```

## Releasing updates to the Chrome Web Store

release-please maintains a separate draft `chore(extension): release <version>` PR
on `master`. Mark it ready and merge it to publish the GitHub release with an
`extension-v<version>` tag and run the
[Release Browser Extension workflow](../../.github/workflows/release-browser-extension.yml).
The workflow builds the store ZIP from that commit and uses `wxt submit` to
submit it to the existing
[Reflect Capture listing](https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd).
After review approval, publish the staged update in the dashboard. The GitHub
release does not indicate store review has finished.

The extension version and changelog are independent of desktop beta/stable
releases. Let release-please update `package.json` and `CHANGELOG.md`. Extension
`feat`/`fix` changes must touch `apps/extension`; shared dependency changes that
need an extension release should include an extension-local change describing
the affected behavior. A `chore` commit alone does not trigger a release.

### Configuration

The workflow reads repository Actions secrets `CHROME_PUBLISHER_ID`,
`CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`, and `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`.
The service account must be linked to the existing publisher in the Chrome Web
Store dashboard. See [Google's setup instructions](https://developer.chrome.com/docs/webstore/service-accounts).
Use the v2 API service account credentials, not the deprecated v1 OAuth tokens.

### Retries and manual recovery

The workflow runs only through release-please. For a failed run, inspect the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole) first, then
rerun the failed job in GitHub Actions if a fresh upload is appropriate. Each rerun
builds a new ZIP from the release commit.

`wxt submit` does not cancel pending reviews by default or skip already submitted
versions. If the version is pending or published, finish recovery in the dashboard
instead of uploading again. The pinned publisher also fails when Google processes
an upload asynchronously; wait for processing and submit the uploaded package in
the dashboard. A published regression needs a higher version containing the fix.

Before merging a Release PR, update listing/privacy declarations for changed
permissions or capture behavior and check compatibility with the oldest supported
installed desktop host. Test the store-installed extension on macOS, including
queued captures while the app is closed. Preserve both extension IDs in
`EXTENSION_ORIGINS`; a store ZIP omits `key` and is unsuitable for unpacked
native-messaging tests. Use a normal `pnpm --filter @reflect/extension build`
for those tests.

### Manual packaging fallback

Run `pnpm check` at the repository root and
`pnpm --filter @reflect/extension test`, then
`pnpm --filter @reflect/extension zip`. The store build omits the dev key. Upload
`apps/extension/.output/reflect-capture-<version>-chrome.zip` to the existing
listing only after checking its current published and submitted versions.

### Listing copy

**Category:** Productivity · **Language:** English

**Single purpose** (one sentence, as the store requires):

> Save the page you are reading — its link, selection, and a screenshot — into the
> Reflect desktop app.

**Detailed description:**

> Reflect Capture saves the page you're reading into Reflect with one click or a
> keyboard shortcut (⌘⇧K / Ctrl+Shift+K).
>
> A capture includes the page's URL and title, your current text selection, and a
> screenshot of the visible tab. Optionally, tick "Capture page text" to include the
> page's readable text as well.
>
> Bookmarking a post on X also saves its link to Reflect. This is enabled by
> default and can be disabled in the popup. The extension observes bookmark
> requests on x.com to identify the post you chose to save.
>
> Captures are handed to the **installed Reflect desktop app** over a local connection
> on your own machine — there is no Reflect account and no Reflect server in the path.
> Capturing works even when the app is closed: the link is held and saved automatically
> the next time Reflect runs. The extension stores no API keys and makes no AI or
> network calls of its own.
>
> Requires the Reflect desktop app: https://github.com/team-reflect/reflect-open

**Privacy policy URL:** `https://github.com/team-reflect/reflect-open/blob/master/docs/privacy.md`
(the "Browser capture" section). Must be live on the public `master` branch before
submission.

### Store assets to attach

- **Store icon** — 128×128, already shipped at `public/icon/128.png`.
- **Screenshots** — at least one 1280×800 (or 640×400) PNG of the capture popup over a
  real page. A ready-to-upload shot lives at
  `store-assets/screenshot-1280x800.png` (the popup over an article, showing the page
  thumbnail, title, note field, and "Save to Reflect"). Refresh it when the popup UI
  changes — resize a clean window grab with
  `magick <grab>.png -resize '1280x800!' store-assets/screenshot-1280x800.png`.

### Permission justifications

Each is reviewed individually; every permission below is exercised by the code:

| Permission | Why it's needed |
| --- | --- |
| `activeTab` | Read the URL/title and grab a screenshot + selection of the tab you capture — only at the moment you click the button or press the shortcut. Avoids any broad host permission. |
| `scripting` | Run a one-line script in the active tab to read the current selection and, when opted in, extract the page's readable text. |
| `nativeMessaging` | The only output: hand each capture to the local `reflect-capture-host` the desktop app registers. No network is used. |
| `storage` | Queue captures locally so a capture survives the app being closed and retries until it spools. |
| `unlimitedStorage` | Queued captures embed a screenshot data URL, which can exceed the default storage quota while waiting for the app. |
| `alarms` | A coarse retry timer so held captures flush once Reflect is installed/launched later. |
| `webRequest` + `https://x.com/*` | Observe bookmark requests on x.com to save the post link to your daily note. |

### Data-handling disclosures (Privacy practices tab)

- **Data collected:** *Website content* (the captured page's URL, title, selection,
  screenshot, and optional page text), plus the post identifier/link when you
  bookmark on X with bookmark capture enabled. The background worker observes
  X bookmark requests; it does not capture unrelated browsing content.
- **Where it goes:** to the user's own machine (the local Reflect desktop app). It is
  **not** sent to Reflect or any third party.
- The three required certifications are all true and can be affirmed:
  1. Data is **not** sold to third parties.
  2. Data is **not** used or transferred for purposes unrelated to the single purpose.
  3. Data is **not** used or transferred to determine creditworthiness or for lending.
