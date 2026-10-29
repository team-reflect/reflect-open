# Porting audio memos (mobile)

**v2 status: all three waves implemented; physical-device pass owed.**
Desktop audio memos shipped first (raw-first recording into the graph +
async BYOK transcription; see the desktop
[audio-memos porting doc](../audio-memos.md)). The mobile waves reuse that
pipeline over a native recorder:

- **In-app wave.** `plugins/tauri-plugin-recording` (AVAudioRecorder → a
  native staging directory, interruption/route-change/cap stops, 10 Hz
  metering events); the shared capture queue in
  `AudioMemoService.openPipeline`
  (`packages/core/src/audio/audio-memo-service.ts`); and a mobile session
  (`packages/core/src/audio/mobile-audio-memo-service.ts`) that ingests
  staged files, including an orphan scan on launch/foreground for stops the
  webview never saw.
- **Reliability wave.** `UIBackgroundModes: audio` (recording continues
  through screen lock and backgrounding; the audio session is active only
  while capturing), and a mount-time reconcile that stops and saves a
  recording that outlived its JS (webview reload/crash) instead of leaving
  a hidden hot microphone.
- **Entry-points wave.** The native-action handshake (persisted queue →
  `actions_ready` → deliver → confirm; see
  [native-entry-points](./native-entry-points.md)), Siri App Intents, the
  home-screen quick action, the record widget (`RecordingWidget` appex,
  `reflect://record-audio`), and the Live Activity with an iOS 17 stop
  intent.

Absent vs. this doc's original sketch: an App Group **audio** inbox.
Recording always happens in the main app process (widgets can't record),
so the plugin's sandbox staging directory is the can't-lose buffer and no
extension writes audio. Still owed: the physical-device pass (entry points,
interruptions, lock-screen continuation). V1's server upload is forbidden
in v2, but V1's *reliability engineering* is the bar.

This is V1 mobile's most engineered feature and the clearest statement of
its philosophy: **critical capture must not depend on the webview being
alive.**

## What V1 mobile does

### Entry points

In-app record button (FAB), lock-screen widget (`reflect-widget://`), Live
Activity / Dynamic Island with a stop button (iOS 17+ `StopRecording` App
Intent), Siri ("Start recording in Reflect"), and a home-screen quick
action. OS-triggered entry points go through the native-action handshake
so they survive cold starts and webview crashes.

### The native pipeline

`ios/App/App/Capacitor Plugins/RecordingPlugin/RecordingPlugin.swift`
(~600 lines):

1. `AVAudioRecorder` captures AAC mono 44.1 kHz (`.m4a`); the idle timer is
   disabled; a Live Activity shows elapsed time.
2. Metering streams at 10 Hz to the webview for the waveform
   (`components/recording-modal/recording-modal.tsx` is presentation only).
3. **Interruptions** (calls, Siri, alarms) and **route changes**
   (headphones unplugged) stop the recording cleanly instead of corrupting
   it.
4. On stop, **Swift uploads directly to Firebase Storage** with metadata
   (`processAs: audioRecording-v2`, user/graph/note IDs, a natively-stored
   auth token, and transcription prefs `initialPrompt`, `formatTranscript`,
   `language`), no webview involved.
5. **Failures persist** in App Group defaults (`filesToUpload`) and retry
   with exponential backoff (2 s → 5 min); `NWPathMonitor` retries when the
   network returns; `beginBackgroundTask` buys upload time after
   backgrounding. Pending uploads survive restarts.
6. The backend transcribes and the transcript syncs into the daily note.
   The user sees "Uploading and processing your audio memo"; the profile
   shows a recordings count.

Transcription preferences are pushed reactively from the webview into the
plugin. Push permission is requested at record time (processing
notifications).

## What changes in v2, and why

V1's reliability came from a server that received the payload. v2 inverts
to local-first:

- **Raw-first is the durable artifact.** Recordings land in the graph
  (desktop: `audio-memos/`, max 10 min, saved immediately) and sync like
  any file. Transcription is a separate, retryable step that never loses
  audio. Mobile reuses the desktop decision.
- **Recording still needs a native layer.** Capture from the lock screen,
  Siri, or a dying webview needs native recording code and (for
  extension-initiated capture) an **App Group inbox** the app ingests on
  next launch; extensions must not touch the Git repo or SQLite.
  Interruption/route-change handling and persisted pending state port as
  requirements, with the App Group container replacing Firebase Storage as
  the can't-lose buffer.
- **Transcription is BYOK cloud** (OpenAI/Gemini keys from the iOS keychain
  via the same secrets module), run by the app's reconciler, with explicit
  privacy UX. `private: true` is enforced at the transcript-insertion and
  inbox boundaries.
- **OS entry points ship with this wave** (widget, Siri, Live Activity,
  quick action): they are most of mobile audio's value and need native
  targets + App Group provisioning regardless of shell.
- Waveform metering ports naturally as plugin events, like the keyboard
  plugin.

## V1 → v2 mapping

| V1                                              | v2                                                            |
| ----------------------------------------------- | -------------------------------------------------------------- |
| Swift upload → Firebase Storage → server        | Raw `.m4a` into the graph (App Group inbox if app is dead)     |
| Server transcription → synced into daily note   | Async BYOK transcription reconciler → daily note               |
| Pending uploads in App Group defaults + backoff | Pending ingest in the App Group inbox; ingest on launch        |
| Transcription prefs pushed to native plugin     | Prefs in settings; reconciler reads them                       |
| Live Activity + widget + Siri + quick action    | Same targets, rebuilt beside the Tauri shell                   |
| Push notification on processing complete        | Dropped (no server); in-app status instead                     |
| Interruption/route-change safe stop             | Port as a requirement of the native recorder                   |

## Open questions (tracked in the grounding brief)

- The App Group + capture-inbox schema (layout, ingest semantics,
  `private: true` at the boundary) and when to provision the App Group and
  extension targets in `ios.project.yml`: cheap early, annoying to
  retrofit, not needed for mobile v1.
- Whether long recordings need chunked ingest for extension memory limits.
