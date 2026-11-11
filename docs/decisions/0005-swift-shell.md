# TDR 0005 — iOS app shell: native Swift with one WKWebView

- **Status:** Accepted
- **Date:** 2026-11-10
- **Scope:** The host process of the iOS app (iPhone, iPad). It replaces
  [TDR 0003](./0003-mobile-shell.md) for iOS only. The desktop apps (macOS,
  Windows, Linux) stay on Tauri. The editor, the note format, the index, git
  sync, and iCloud behaviour do not change.
- **Decision driver:** How do we get full control of the iOS host (keyboard,
  lifecycle, StoreKit, extensions, and later native navigation chrome) without
  a second frontend or a second copy of the Rust logic?
- **Alternatives evaluated:** stay on Tauri iOS; UniFFI for the Swift to
  Rust boundary.

<!--FIXME: check if there is any different and/or not-matching betweent the doc and the implement. Adress these issues if any -->

---

## TL;DR

**iOS moves from the Tauri shell to a native Swift app in `apps/ios/`.** The
app hosts one `WKWebView` that renders the same Vite bundle as desktop. Rust
links in as a static `ReflectCore.xcframework`. iOS no longer uses Tauri, wry,
or tao.

The frontend and the Rust logic stay shared. Only the host changes: the Swift
app takes the place of the Tauri runtime, and the Web layer gets one more host
implementation next to Tauri and the browser dev bridge.

## The decision

### Rust: `reflect-core` and `reflect-ffi`

- A new crate `reflect-core` holds the command implementations that live in
  the Tauri crate today. It has no Tauri dependency. A `Host` trait gives it
  the few things the host must supply: events, main-thread work, opening
  URLs, and paths and version info passed in at startup.
- Each `#[tauri::command]` in `apps/desktop/src-tauri` becomes a one-line
  call into `reflect-core`. Desktop keeps typed commands and pays no JSON
  round trip.
- A new crate `reflect-ffi` (`staticlib`) exposes a small C ABI: create and
  free a core, dispatch a command by name with JSON arguments, request
  headers, and an optional byte body, and register event and main-thread
  callbacks. Headers carry the metadata of binary commands (the upload id of
  `asset_upload_append`). `cbindgen`
  generates the header. A script packs device and simulator builds into the
  xcframework.
- **No UniFFI for now.** The caller of almost every command is the Web layer,
  so Swift should be a pipe: adding a command must need no Swift change.
  UniFFI generates Swift types, not TypeScript, so it adds a translation
  step on the Web path and gives nothing back. We re-evaluate when native
  Swift screens start to call Rust directly. The `reflect-core` API is the
  same under both choices, so only the thin FFI crate would change.

### Web to shell protocol

- The page loads from the custom scheme `reflect-app://localhost`.
- JavaScript calls a command with `fetch` to `__ipc/<command>` on that
  origin. A `WKURLSchemeHandler` passes the request to `reflect-core` on a
  background thread and returns JSON or raw bytes.
- The shell pushes events to the page with `callAsyncJavaScript`.
- Command names and the wire format do not change: `plugin:<name>|<cmd>`
  names stay, arguments are camelCase JSON, and errors are
  `{ kind, message }`.
- The JavaScript side is new: the `swift-*.ts` adapters replace `invoke` and
  `listen` from `@tauri-apps/api`. They must keep the behaviour of binary
  bodies, binary replies, events, and plugin calls. Underneath, Tauri on iOS
  also sends IPC as `fetch` to a custom scheme, so binary bodies,
  `crypto.subtle`, and `localStorage` already work in this setup.

### Frontend

- One more host implementation: the `swift-*.ts` adapters sit in
  `apps/desktop/src/services/`, next to the Tauri and browser adapters, plus
  host detection at boot.
- Business code does not change: `packages/core`, `packages/app`, and
  `apps/desktop/src/mobile/` stay host-agnostic.

### Settled details

- **Shared Swift code:** the shell depends on the `apple/` Swift package.
  Recording, App Store, and capture code exist only there. The Tauri plugins
  and the Swift shell each add a thin adapter.
- **Minimum iOS:** stays 16.0 (widget 16.2). The Vite target stays
  `safari16`.
- **Identity and release:** the new shell ships first under the beta
  identity `app.reflect.ios.beta`. The existing manual TestFlight workflow
  stays as it is. A second manual workflow builds the new shell. The person
  who runs a workflow picks the shell.
- **Build number:** stays the commit count (`git rev-list --count HEAD`),
  with no offset. Both workflows upload to the same beta record, so one
  commit can go to TestFlight from only one of them.
- **Origin change:** the move from `tauri://localhost` to
  `reflect-app://localhost` resets `localStorage` once. We accept this.
  The keys there are caches and once-per-period UI markers (subscription
  seed, App Store environment, theme cache, What's New seen ids, skippable
  paywall day, review prompt times). After the reset the app queries the
  subscription again and can show What's New, the skippable paywall, or the
  review prompt one more time.
- **ATS:** starts with `NSAllowsLocalNetworking` only. We relax it only when
  a real request needs it.
- **Xcode project:** uses the JSON project format of Xcode 27.2
  (`Reflect.xcodeproj/project.xcproj`), not XcodeGen. Build settings live in
  `.xcconfig` files.
- **Swift language mode:** the new Swift targets use Swift 5 language mode
  with explicit `@MainActor`. A Swift 6 module that hands a `@MainActor`
  closure to a Swift 5 module crashes at runtime when the closure runs off
  the main thread, and the compiler gives no warning. One mode across our
  modules avoids that trap.

## Why

- **Control of the host.** The hard iOS problems (keyboard, WebContent
  termination, StoreKit, extensions, native navigation) are host problems.
  Under Tauri each one needs a workaround around tao and wry, or a wait for
  upstream. In our own shell they are ordinary UIKit code.
- **Reuse stays full.** The Web layer already reaches the host only through
  the adapters in `apps/desktop/src/services/`. The heavy Rust logic already
  lives in crates without Tauri types. The Tauri crate is a thin wrapper.
- **Small, known protocol.** The shell uses the same scheme-based IPC
  mechanism that Tauri uses on iOS today, with the same command names and
  payloads.
- **Desktop gains too.** The core extraction makes the Tauri crate thinner
  and testable without Tauri mocks.

## Accepted costs and risks

- **Private selector swizzle.** Programmatic focus (the keyboard opens when
  JavaScript focuses the editor) needs a swizzle of a private WebKit
  selector, as today. If the selector is missing at runtime, the shell skips
  it and a user tap still opens the keyboard.
- **One more native codebase.** We maintain a Swift app in addition to the
  Tauri desktop shell. Policy stays in TypeScript and capabilities stay in
  Rust, so the shell stays small.
- **Long-lived integration branch.** The work lands on a `swift` branch
  that merges back to `master` once, after pre-merge validation. The core
  extraction moves code that changes on `master`, so we merge `master` into
  `swift` often.
- **Yearly Xcode and iOS updates** are now ours. We no longer wait for tao
  and wry to adapt.

## Phased route

1. **Prerequisites:** land the `apple/` Swift package with the shared Swift
   code, extract `reflect-core` from the Tauri crate one domain at a time, add `reflect-ffi` and the xcframework build, add the
   `swift-*.ts` adapters. No user-visible change. Desktop works after every
   step.
2. **Shell boots:** the Swift app loads the bundle, routes `__ipc`, serves
   assets, proxies HTTP, and opens an iCloud graph. Daily note editing works
   on a device.
3. **Parity:** keyboard behaviour, plugins as Swift capabilities, StoreKit,
   recording, share extension, widget, intents, flavors, Sentry, WebContent
   recovery, and CI. The shell produces an uploadable IPA.
4. **Pre-merge validation:** the `swift` branch is reviewed and merged to
   `master`. The first TestFlight build of the new shell follows the merge.
5. **Later:** native chrome (tab bar, navigation bar, native screens), then
   the switch of the stable identity `app.reflect.ios` to the Swift shell
   and removal of the Tauri iOS code. // FIXME: I do not think you need to meantion the `swift` branch here. This is just a detail of the implementation and it's useless for the decision record. Review the whole doc and cleanup any other implementation details that are not relevant to the decision record. The decision record should focus on the "what" and "why", not the "how".

Until step 5, the Tauri iOS shell stays the shipping iOS app, and we can stop
at any point. The core extraction and the extra host adapter keep their value
for desktop either way.
