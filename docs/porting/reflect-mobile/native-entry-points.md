# Porting native entry points

**v2 status: shipped with the audio wave, partially dropped.** Shipped: the
lock-screen/home-screen widget (opens `reflect://record-audio`, forwarded
by the Rust shell into the recording plugin's queue), Siri App Intents
("Start/Stop recording in Reflect", in-process `AppIntent`s in the app
target posting NotificationCenter requests), the home-screen quick action
(a shortcut-item handler the plugin adds to tao's app delegate), and the
Live Activity with an iOS 17 `LiveActivityIntent` stop button. The
**native-action handshake** below is implemented in
`plugins/tauri-plugin-recording` (persisted queue → `actions_ready` →
deliver → confirm-after-2s), as prescribed. Push notifications and
universal links stay dropped (no server). The route-shaped `reflect://`
grammar is not a mobile surface yet; only `record-audio` is registered on
iOS.

## What V1 mobile does

### Entry points inventory

| Entry point | Mechanism | Action |
| --- | --- | --- |
| Lock-screen widget | `ios/App/App Widget/LockScreenWidget.swift`, opens `reflect-widget://` | Start recording |
| Live Activity / Dynamic Island | `RecordingActivityWidget.swift`, elapsed timer + stop button (iOS 17+ `StopRecording` App Intent, `openAppWhenRun = false`) | Stop recording |
| Siri / Shortcuts | `ios/App/Intents/Intents.swift` — `StartRecording` App Intent ("Start recording in Reflect", `openAppWhenRun = true`) | Start recording |
| Home-screen quick actions | `UIApplicationShortcutItems` in Info.plist | Create note; Record audio |
| Universal links | Associated domains `m.reflect.app`, `l.reflect.app`, Firebase Dynamic Links domains | Magic-link auth, web→app handoff |
| Push notifications | `@capacitor/push-notifications`, APNs entitlement | Minor surface (processing updates) |

### The native-action handshake

OS entry points can fire before the webview exists, while it boots, or just
before it crashes. V1's answer
(`ios/App/App/Capacitor Plugins/NativeActionsPlugin/`,
`capacitor/native-actions.ts`):

1. Native code **queues** the action (`requestedAction`) instead of firing
   an event into a webview that may not be listening.
2. The webview calls `finishSetup()` once its UI is mounted and past the
   loading gates; only then is the action delivered.
3. After executing, the webview calls `confirmPerformed()`. Recording
   confirmation waits ~2 s so a crash during modal presentation doesn't
   mark the action done.
4. If the app dies before confirmation, the action **re-fires on next
   launch**: no lost or double-fired actions.

## What changes in v2, and why

- **The handshake ports as a pattern.** Every v2 OS entry point needs the
  same queue-until-ready / confirm-after-execute contract: Tauri does not
  change WKWebView mortality. Implement it once, in the plugin that owns OS
  intents.
- **Widgets / Siri / quick actions ship with the audio wave**: in V1 they
  are recording-centric and most of their value is capture. A "Create
  note" quick action is cheap to add.
- **Push notifications are dropped**: no server. v2 transcription is local
  app work with in-app status.
- **Universal links are dropped**: no web app, magic links, or Dynamic
  Links.
- **Deep links**: desktop registers a route-shaped `reflect://` scheme
  ([deep-links porting doc](../deep-links.md)). Mobile registration is
  deferred until shortcuts/automation ask, mapping onto the same grammar
  and the capture inbox for write links (`reflect://append`). That grammar
  subsumes `reflect-widget://`.

## V1 → v2 mapping

| V1                                          | v2                                                             |
| ------------------------------------------- | --------------------------------------------------------------- |
| NativeActions queue/finishSetup/confirm     | Port the pattern for all OS-triggered actions                    |
| Lock-screen widget + Live Activity          | Audio wave, rebuilt beside the Tauri shell                       |
| Siri `StartRecording` / `StopRecording`     | Audio wave (App Intents unchanged in spirit)                     |
| Quick actions (create note, record)         | Audio wave; create-note is cheap to include                      |
| `reflect-widget://`                         | Subsumed by the route-shaped `reflect://` grammar, when mobile   |
| Universal links + Dynamic Links             | Dropped (no server, no web, no magic links)                      |
| Push notifications                          | Dropped (no server)                                              |
