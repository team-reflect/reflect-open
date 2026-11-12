# Safari extension

The Safari app extension that ships inside Reflect.app as
`Contents/PlugIns/SafariExtension.appex`. Safari delivers the capture
extension's `sendNativeMessage` calls here instead of to `reflect-capture-host`.
The handler spools each capture into the App Group inbox, and the desktop app
relays the inbox into the graph (`crates/core/src/capture.rs`). Swift only: no
Rust, no network.

Tauri's bundler cannot build app extensions. `apps/tauri/scripts/safari-extension.ts`
builds the target unsigned, copies the WXT Safari build into its Resources, and
embeds it for its callers to sign. The script passes these build settings:

- `REFLECT_APP_IDENTIFIER`: the app's bundle id. The appex bundle id must start
  with it.
- `REFLECT_APP_GROUP`: the App Group. `Info.plist` stores it as
  `ReflectAppGroup`, and the app's relay reads that key to find the same
  container.
- `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`: the app's version.

`ReflectSafari.xcodeproj` uses the JSON project format of Xcode 27.2
(`project.xcproj`). Xcode 27.0 and later can read it. Edit it in Xcode or by
hand. `Sources` is a synced folder: new Swift files build without a project
change. See [Safari extension](../../docs/distribution.md#safari-extension) for
signing and local testing.
