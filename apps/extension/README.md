# Reflect Capture (Chrome extension)

Save the page you're reading into Reflect: ⌘⇧K (or the toolbar button) opens
the capture popup — screenshot, title, selection, optional note — and hands
the capture to the **installed desktop app** through a local native-messaging
host. No Reflect-hosted services are involved, and capture works even while
the app is closed: the host spools into the graph's capture inbox
(`<graph>/.reflect/inbox/`), and the app drains it on next launch.
[Plan 11](../../docs/plans/11-link-capture.md) is the design doc.

## Architecture in one breath

popup → `chrome.storage` queue → background `sendNativeMessage` →
`reflect-capture-host` (Tauri sidecar, registered by the desktop app on every
launch) → capture inbox → desktop drain (`@reflect/core` `actions/capture`):
raw note + daily `## Links` entry now, meta-scrape + BYOK AI description
async. The extension stores no keys and makes no AI or network calls; its
only honest status is **queued** — it cannot observe the desktop drain.

## Develop

```bash
pnpm --filter @reflect/extension dev     # wxt dev server (auto-reloads in Chrome)
pnpm --filter @reflect/extension build   # production build → .output/chrome-mv3
pnpm --filter @reflect/extension test    # vitest over lib/
```

Load the production build via `chrome://extensions` → Developer mode →
**Load unpacked** → `apps/extension/.output/chrome-mv3`.

For the native hop to work, run the desktop app once (it writes the host
manifests for detected browsers and the active-graph pointer file), then
restart Chrome so it re-reads the manifests.

## The extension ID is pinned — don't regenerate it casually

`wxt.config.ts` carries a public `key`, which makes the extension ID
`dlbliojklpickgimjdmjjdnbjdiomjik` everywhere: unpacked dev builds, CI, and
the Chrome Web Store (the store keeps a key-pinned ID on first upload). The
desktop app's host manifests (`apps/desktop/src-tauri/src/capture.rs`,
`EXTENSION_ORIGINS`) allowlist exactly this origin — changing the key without
updating that constant silently breaks the native hop. The private half of
the key is deliberately discarded: unpacked loads and store uploads only need
the public key, and the store re-signs every upload.

To derive an ID from a key (if it ever has to change):

```bash
openssl genrsa 2048 > key.pem
openssl rsa -in key.pem -pubout -outform DER | base64        # manifest "key"
openssl rsa -in key.pem -pubout -outform DER | shasum -a 256 \
  | head -c 32 | tr '0123456789abcdef' 'abcdefghijklmnop'    # extension ID
```

## Publishing checklist (Chrome Web Store)

1. `pnpm --filter @reflect/extension zip` → upload `.output/*-chrome.zip`.
2. Confirm the store item ID matches `dlbliojklpickgimjdmjjdnbjdiomjik`
   (it will, while the manifest `key` is unchanged).
3. If the store ever assigns a different ID, append
   `chrome-extension://<store-id>/` to `EXTENSION_ORIGINS` in
   `apps/desktop/src-tauri/src/capture.rs` and ship a desktop release —
   manifests rewrite themselves on next launch.
