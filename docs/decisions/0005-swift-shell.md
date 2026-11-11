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
- Both shells call these commands by name through `Core::dispatch`, so a
  command is registered once. The Tauri crate keeps only the desktop-only
  commands (windows, menus, calendar).
- A new crate `reflect-ffi` (`staticlib`) exposes a small C ABI: create and
  free a core, dispatch a command by name with JSON arguments, request
  headers, and an optional byte body, resolve an asset request, and
  register event and main-thread callbacks. The app links it as
  `ReflectCore.xcframework`. The crate holds no logic of its own: it only
  converts arguments and results.
- **No UniFFI for now.** The caller of almost every command is the Web layer,
  so Swift should be a pipe: adding a command must need no Swift change.
  UniFFI generates Swift types, not TypeScript, so it adds a translation
  step on the Web path and gives nothing back. We re-evaluate when native
  Swift screens start to call Rust directly. The `reflect-core` API is the
  same under both choices, so only the thin FFI crate would change.

### Web to shell protocol

- The page loads from the custom scheme `reflect-app://localhost`.
- JavaScript calls a command with `fetch` to `__ipc/<command>` on that
  origin. A `WKURLSchemeHandler` answers it: `plugin:` and `host.` commands
  run in the shell, every other command goes to `reflect-core` on a
  background thread. The reply is JSON or raw bytes.
- The same scheme proxies the app's HTTP requests (`__http`), and a second
  scheme, `reflect-asset`, serves files of the graph. `reflect-core` decides
  which file an asset request names and which bytes a `Range` header
  selects; the shell reads the file.
- The page defines `window.__reflectHost` when it boots and tells the shell
  that it is ready. The shell keeps its events until then, and delivers an
  event by evaluating a dispatch call on that object.
- The request routing, the caller check and the HTTP proxy are Swift today.
  They hold no Apple-specific logic, so they can move into `reflect-core`
  when a second native shell needs them.
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
- Business code stays host-agnostic: `packages/core`, `packages/app`, and
  `apps/desktop/src/mobile/` do not call a shell. Where the mobile app must
  differ in the Swift shell, it reads the `isSwiftMobile` platform fact.

### Settled details

- **Shared Swift code:** the `apple/` Swift package holds the Swift code
  that depends on no app target, on no Rust binary and on no third-party
  package: the web transport (`WebHostKit`), recording, capture, the
  keyboard tuning, web sign-in, and the App Store environment probe. Its
  tests run on macOS with `swift test`. The Swift shell and the Tauri
  plugins each add a thin adapter that turns a command into a call of a
  module. The app targets hold the entry points, the wrapper of the Rust
  core, and the code that needs a third-party package (Sentry). The share
  extension, the widget, and the App Intents are the same source files in
  both apps. Purchases are the shell's own StoreKit code, because the Tauri
  app uses a third-party plugin for them.
- **Minimum iOS:** stays 16.0 (widget 16.2). The Vite target stays
  `safari16`.
- **Identity and release:** the new shell ships first under the beta
  identity `app.reflect.ios.beta`: the manual TestFlight beta workflow builds
  the Swift shell. Release builds of the stable identity stay on the Tauri
  shell until the switch.
- **Build number:** stays the commit count (`git rev-list --count HEAD`),
  with no offset.
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
- **Yearly Xcode and iOS updates** are now ours. We no longer wait for tao
  and wry to adapt.

## Phased route

1. **Prerequisites:** the shared `apple/` Swift package, `reflect-core`
   extracted from the Tauri crate, `reflect-ffi`, and the `swift-*.ts`
   adapters. No user-visible change.
2. **Shell boots:** the Swift app loads the bundle, answers commands, serves
   assets, proxies HTTP, and opens an iCloud graph.
3. **Parity:** keyboard behaviour, the plugins as Swift capabilities,
   StoreKit, recording, share extension, widget, intents, flavors, Sentry,
   WebContent recovery, and CI. The shell produces an uploadable IPA.
4. **Beta:** TestFlight builds of the beta identity come from the Swift
   shell.
5. **Later:** native chrome (tab bar, navigation bar, native screens), then
   the switch of the stable identity `app.reflect.ios` to the Swift shell
   and removal of the Tauri iOS code.

Until step 5, the Tauri iOS shell stays the shipping App Store app, and we
can stop at any point. The core extraction and the extra host adapter keep
their value for desktop either way.
