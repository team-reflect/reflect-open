# tauri-plugin-keyboard

Reflect's iOS webview input tuning. No keyboard state crosses the bridge:
the webview is pinned and keyboard avoidance is derived from `visualViewport`
on the web side, so the whole plugin is native-only tuning
(`ios/Sources/KeyboardPlugin.swift`):

- pins the webview scroll view so the system keyboard cannot shove the page,
- removes the form-assistant accessory bar above the keyboard,
- lets deliberate programmatic `focus()` calls raise the keyboard.

The plugin exposes no commands and has no TypeScript binding. Haptics, its
former single command, lives in `plugins/tauri-plugin-mobile-haptics` now;
adding a first command back here means recreating `permissions/default.toml`
and the capability mount, per that plugin's README checklist.

Mobile-only: `apps/desktop/src-tauri` depends on this crate for iOS/Android
targets only and registers it under `#[cfg(mobile)]`. Android has no
implementation yet and fails the build on purpose (`src/mobile.rs`).
