# The `apple/` Swift package

`apple/` is a local Swift package (`ReflectApple`) for the Swift code that the
iOS apps share: the Swift shell (`apps/ios`) and the Tauri iOS app. A module
depends on no app target, on no Rust binary and on no third-party package, so
`swift test` runs its tests on macOS. The adapters that turn a command into a
call of a module stay in the shells: `apps/ios/Sources/Capabilities` and the
Tauri plugins. App entry points, App Intents, and the code that needs the Rust
core or a third-party package stay in the Xcode targets.

| Module | Layer | Used by |
| --- | --- | --- |
| `CaptureShared` | shared | App targets, `ShareExtension` |
| `RecordingShared` | shared | App targets, `RecordingWidget`, `RecordingKit` |
| `AppStoreKit` | engine | Swift shell, `tauri-plugin-app-store` |
| `KeyboardKit` | engine | Swift shell, `tauri-plugin-keyboard` |
| `RecordingKit` | engine | Swift shell, `tauri-plugin-recording` |
| `WebAuthKit` | engine | Swift shell, `tauri-plugin-web-auth` |
| `WebHostKit` | engine | Swift shell |

```bash
swift build --package-path apple
swift test --package-path apple    # or `pnpm test:swift`
(cd apple && xcodebuild build -scheme ReflectApple-Package -destination 'generic/platform=iOS Simulator' -quiet)
```

The `test-swift` CI job runs the last two commands. It does not build the iOS
app, so it does not replace a full iOS app build.

## Adding a module

1. Add a `Module(...)` row to the `modules` table in `apple/Package.swift`.
   `layer` decides what it may depend on: `.shared` modules depend on nothing,
   `.engine` modules on `.shared` ones. The name is `<Domain>` plus the layer's
   suffix: `Shared` for `.shared`, `Kit` for `.engine`. The manifest fails to
   load otherwise.
2. Put sources in `apple/Sources/<Module>/`. Set `hasTests: true` and add
   `apple/Tests/<Module>Tests/` (Swift Testing) for tests.
3. Every module is a product. Link it only where it is used. The Swift shell
   links it under `package-product-members` in
   `apps/ios/Reflect.xcodeproj/project.xcproj`. A target of the Tauri app
   links it in `apps/desktop/src-tauri/gen/apple/project.yml`
   (`- package: ReflectApple`, `product: <Module>`), then regenerate the
   project (see that file's header). A plugin adds `.product(name: "<Module>", package: "ReflectApple")` to its
   `ios/Package.swift` (tools 6.2, `.iOS(.v15)`, `swiftLanguageModes: [.v5]`).

## Rules

- **Plugins rebuild through cargo.** A plugin's Swift is built by `swift-rs` in
  the plugin's cargo build script, which reruns only for listed paths. A plugin
  that depends on `apple/` lists `../../apple/Package.swift` and
  `../../apple/Sources` with `cargo:rerun-if-changed` in its `build.rs`;
  without them an edit in `apple/` links stale Swift.
- **App target and plugins talk through `NotificationCenter`.** The app target
  cannot import a plugin module, so shared names live in a `.shared` module
  that both link (`RecordingNotifications.swift`). Linking a module that
  `libapp.a` also contains works.
- **App Intents stay in the target.** Their metadata is extracted from the
  target's own sources, so intent files are in `apps/ios/Shared/`, and each
  target that exposes them compiles them. The extensions' sources are in
  `apps/ios/Extensions/`. Both Xcode projects reference these folders.
- **Swift 5 language mode.** Moving code does not change its concurrency shape:
  no new `@MainActor`, `async`, or `Task {}`.
- **`InternalImportsByDefault` is on.** A module used in a `public` signature
  needs `public import`.
- **iOS 15 is the floor.** `swift-rs` compiles plugins and their `apple/`
  modules for iOS 15 (Xcode 27 clamps Tauri's iOS 13 to 15), so the package
  declares `.iOS(.v15)` and the compiler checks every `#available`.
- **Wrap iOS-only files in `#if os(iOS)`.** `swift build` and `swift test`
  compile every target for macOS too, and `canImport(ActivityKit)` is true
  there. Keep logic you want to test on the Mac in a separate, unwrapped file.
