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

## Link preview capture

To verify URL-only share captures:

1. Share a web page from Safari to Reflect without a screenshot.
2. Open Reflect and wait for capture enrichment to finish.
3. Open the generated capture note and confirm it contains a `## Screenshot`
   section whose asset is a JPEG under `assets/`.
4. Repeat with a page that has no representative image and confirm enrichment
   still completes without a screenshot.
5. Mark either the capture note or its daily note `private: true` before
   enrichment and confirm no preview is attached.

The preview comes from Apple's LinkPresentation framework. It is expected to
vary by website and OS release, so automated tests cover lifecycle and privacy
behavior while this simulator check covers the system integration.

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
