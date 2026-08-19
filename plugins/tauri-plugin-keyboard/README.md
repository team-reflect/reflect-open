# tauri-plugin-keyboard

Reflect's iOS webview input tuning. No keyboard state crosses the bridge:
the webview is pinned and keyboard avoidance is derived from `visualViewport`
on the web side, so the whole plugin is native-only tuning
(`ios/Sources/KeyboardPlugin.swift`):

- pins the webview scroll view so the system keyboard cannot shove the page,
- removes the form-assistant accessory bar above the keyboard,
- lets deliberate programmatic `focus()` calls raise the keyboard.

The plugin exposes no commands and has no TypeScript binding; the Rust crate
only registers the Swift half. Adding a first command means recreating
`permissions/default.toml`, the capability mount in
`apps/desktop/src-tauri/capabilities/mobile.json`, and a TS binding under
`packages/core/src/ipc/`; a sibling plugin's README carries the checklist.

Mobile-only: `apps/desktop/src-tauri` depends on this crate for iOS/Android
targets only and registers it under `#[cfg(mobile)]`. Android has no
implementation yet and fails the build on purpose (`src/mobile.rs`).
