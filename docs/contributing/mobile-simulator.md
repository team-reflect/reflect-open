# Running the iOS simulator

Reflect mobile is the iOS target of `apps/desktop`, so the simulator dev loop
uses Tauri's iOS command rather than a separate app package.

From the repo root:

```bash
pnpm tauri:ios:dev "iPhone 17 Pro"
```

The root `tauri:ios:dev` script delegates to `apps/desktop`, so the command
runs the usual sidecar step and starts Vite through Tauri's
`beforeDevCommand`. On a physical device, run `pnpm tauri:ios:dev --host`
instead.

The script applies `src-tauri/tauri.ios.dev.conf.json`, and debug builds are
the dev flavor: they install as `Reflect Dev` (`app.reflect.ios.dev`, own
icon, own `group.app.reflect.dev` App Group, no iCloud), so they coexist with
the TestFlight/App Store app instead of colliding with its install record.
Plain `tauri ios dev` no longer works on its own: it would build the dev
bundle id but try to launch `app.reflect.ios`.

To see simulator names:

```bash
xcrun simctl list devices available
```

The first run can be quiet for a while because Xcode is compiling the Rust
crate, the Swift keyboard plugin, and native dependencies for
`aarch64-apple-ios-sim`. A healthy launch eventually prints the Plan 19 probe
lines from `spike_mobile.rs`:

```text
[plan19-spike] PASS: keychain round-trip
[plan19-spike] PASS: sqlite fts5
[plan19-spike] PASS: documents file io
[plan19-spike] PASS: libgit2 init+commit
```

## The software keyboard

The simulator hides the software keyboard whenever "Connect Hardware
Keyboard" is enabled (I/O → Keyboard, ⇧⌘K) — focusing the editor then
types through the Mac keyboard with no on-screen keyboard and no
`keyboardChange` events, which looks like a keyboard bug but isn't. Turn
that setting off (or press ⌘K with the app focused) to exercise the real
keyboard-avoidance path.

`tauri ios dev` may normalize generated files under
`apps/desktop/src-tauri/gen/apple/`, including `project.pbxproj` quoting and
merged `Info.plist` usage descriptions. Inspect those diffs before committing;
when the generated output is intentionally refreshed, update the source
template in `apps/desktop/src-tauri/ios.project.yml` or
`apps/desktop/src-tauri/Info.plist` first.

## Exercising share capture without the share sheet

The share extension only writes an envelope into the App Group inbox — the
main app relays, drains, and enriches it on the next foreground. Because the
simulator's containers are plain directories on the host, you can spool that
envelope yourself and exercise the whole pipeline (relay → drain → meta
scrape → preview image → AI enrichment) deterministically, without driving
the share sheet. This is how the enrichment fixes in #884/#886/#888 were
debugged and verified.

With the app running and a local graph created:

```bash
# 1. The dev App Group container (group id per ShareExtension/CaptureInbox.swift)
GROUP=$(xcrun simctl get_app_container booted app.reflect.ios.dev groups \
  | grep group.app.reflect.dev | awk '{print $2}')

# 2. Spool a link-capture envelope, exactly as the extension would:
#    write a .tmp sibling, then rename — the relay only picks up committed
#    .json files, so it can never see a half-written envelope
ID=$(uuidgen | tr 'A-Z' 'a-z')
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
mkdir -p "$GROUP/inbox"
printf '{"version":1,"id":"%s","url":"https://example.com/article","title":"","capturedAt":"%s","source":"ios-share"}' \
  "$ID" "$NOW" > "$GROUP/inbox/$ID.json.tmp"
mv "$GROUP/inbox/$ID.json.tmp" "$GROUP/inbox/$ID.json"

# 3. Trigger the relay: background the app, then foreground it
xcrun simctl launch booted com.apple.mobilesafari
xcrun simctl launch booted app.reflect.ios.dev
```

The envelope shape is `captureEnvelopeSchema` in
`packages/core/src/actions/capture-envelope.ts` (the id must be a lowercase
8-4-4-4-12 uuid; `capturedAt` decides which daily note the link lands on).
An empty `title` exercises the URL-only path most mobile apps produce;
setting one exercises the share-sheet-supplied-title path.

Results land in the graph, which is the app data container's `Documents/`:

```bash
DATA=$(xcrun simctl get_app_container booted app.reflect.ios.dev data)
cat "$DATA"/Documents/notes/capture-*.md     # frontmatter shows captureStatus
ls "$DATA"/Documents/assets/                 # fetched preview images
cat "$DATA"/Documents/daily/$(date +%F).md   # the daily's Links entry
```

Two behaviors worth knowing while iterating:

- Re-spooling the **same URL on the same day** dedups into the existing
  capture note and resets it to `captureStatus: pending`, so enrichment runs
  again — handy for re-testing without minting new notes.
- `xcrun simctl openurl booted "reflect://note/<capture base name>"` opens
  the note in the app for a visual check (approve the confirmation dialog in
  the simulator).
