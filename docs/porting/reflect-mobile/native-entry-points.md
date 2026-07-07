# Porting native entry points

**v2 status: shipped with the audio wave, partially dropped.** The
recording entry points are in: the lock-screen/home-screen widget (opens
`reflect://record-audio`, forwarded by the Rust shell into the recording
plugin's queue), Siri App Intents ("Start/Stop recording in Reflect",
in-process `AppIntent`s in the app target posting NotificationCenter
requests), the home-screen quick action (a shortcut-item handler the plugin
adds to tao's app delegate), and the Live Activity with an iOS 17
`LiveActivityIntent` stop button. The **native-action handshake** below is
implemented in `plugins/tauri-plugin-recording` (persisted queue →
`actions_ready` → deliver → confirm-after-2s), exactly as this doc
prescribed. Push notifications and universal links stay dropped (no
server); the route-shaped `reflect://` navigation grammar is still not a
mobile surface — only the `record-audio` verb is registered on iOS.

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

OS entry points can fire before the webview exists, while it is booting,
or right before it crashes. V1's answer
(`ios/App/App/Capacitor Plugins/NativeActionsPlugin/`,
`capacitor/native-actions.ts`):

1. The native side **queues** the requested action (`requestedAction`)
   in native state — it does not fire an event into a webview that may
   not be listening.
2. The webview calls `finishSetup()` once its UI is actually mounted and
   the app is past its loading gates; only then is the action delivered
   as an event.
3. After executing, the webview calls `confirmPerformed()`. Recording
   confirmation is deliberately delayed ~2 s so a webview crash during
   modal presentation doesn't mark the action done.
4. If the app dies before confirmation, the queued action **re-fires on
   next launch** — no lost or double-fired actions across restarts.

## What changes in v2, and why

- **The handshake ports as a pattern.** Any v2 OS entry point (widget →
  record, quick action → new note) needs the same queue-until-ready /
  confirm-after-execute contract between the native layer and the
  webview, for exactly the same reasons — Tauri does not change WKWebView
  mortality. Implement it once, in the plugin that owns OS intents.
- **Widgets / Siri / quick actions ship with the audio wave** — they are
  recording-centric in V1 and most of their value is capture. "Create
  note" as a quick action is cheap to add alongside.
- **Push notifications are dropped** — there is no server to send them.
  V1 used them mainly for processing updates; v2's transcription is local
  app work with in-app status.
- **Universal links are dropped** — no web app, no magic-link auth, no
  Dynamic Links. Nothing to hand off.
- **Deep links**: desktop v2 registered a route-shaped `reflect://`
  scheme ([deep-links porting doc](../deep-links.md), shipped). Mobile
  registration is deferred — revisit when shortcuts/automation ask for
  it, mapping onto the same route grammar and the capture inbox for write
  links (`reflect://append`). The `reflect-widget://` scheme's job is
  subsumed by that grammar.

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
