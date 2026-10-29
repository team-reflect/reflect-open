# Reflect V1 Mobile: Audio Memos Grounding Brief

How audio memos work in the Reflect V1 mobile app, as a reference for the V2 rewrite. All file
paths refer to the V1 mobile codebase (`~/repos/reflect-mobile`), not this repository.

For broader context, see [Reflect V1 Overview](./reflect-v1-overview.md) and
[Reflect V1 Mobile Overview](./reflect-v1-mobile-overview.md).

## What It Is

Audio memos are the fastest mobile capture path: record on the phone, upload, transcribe, and
append the text to the daily note. The feature is native iOS capture plus webview presentation,
because recording must work from the lock screen, Siri, widgets, and quick actions, where the
React app may not be fully alive yet.

For the user it is simple: start recording, speak, stop, and the transcript appears in today's
daily note through normal sync. The implementation is the clearest V1 example of "critical
capture must not depend on the webview."

## Entry Points

- The in-app record button and the floating `+` menu's microphone action.
- The lock-screen widget, via the `reflect-widget://` URL.
- The home-screen quick action "Record audio."
- Siri / App Intents ("Start recording in Reflect").
- The Live Activity / Dynamic Island: status, elapsed time, and a stop button.

Most OS entry points post a native `recordAudio` notification. The `NativeActions` plugin holds
the action until the webview's listeners are ready, then fires it. The webview confirms after
the recording modal survives a short delay. The handshake exists because outside activation can
reload or crash the webview, and the action must not be lost or run twice.

## User Experience

Recording opens as an Ionic modal (`components/recording-modal/`):

- Opening it requests push permission, because V1 processing is server-side and may finish
  later.
- Recording starts as soon as the modal appears. Tapping or swiping outside does not dismiss
  it; only the recording lifecycle closes it.
- Native metering streams into the webview as a live waveform.
- On stop, the app shows "Uploading and processing your audio memo."

There is no review step for the raw audio. While backend records are `pending` or `processing`,
`AudioRecordingStore` shows a processing count. The profile modal shows "Recordings to upload"
for files still queued natively.

## Native Recording Pipeline

`RecordingPlugin.swift`:

1. Configure `AVAudioSession` and request microphone permission.
2. Record AAC mono, 44.1 kHz, to an `.m4a` under `audio-uploads/`, with timers for metering and
   Live Activity updates, and the idle timer off.
3. On stop, add the file to a persisted pending-upload queue.
4. Upload from Swift to Firebase Storage. Delete the local file only after success.

The upload is native by design: when recording ends (especially from a phone call or another
interruption), JavaScript may not wake up in time.

## Upload and Transcription

The upload carries metadata for the V1 backend: `processAs: audioRecording-v2`, user and graph
IDs, today's daily note ID, native OAuth token details, and the transcription prompt, format,
and language. The webview preference store owns those preferences. `RecordingView` pushes
changes to Swift through `Recording.setup`, so uploads carry the latest values.

The backend transcribes and applies the result to the daily note. The app receives it through
the normal Firestore / SQLite / Yjs sync path.

## Reliability Behavior

- Pending uploads persist in shared defaults and survive restarts.
- Retries use exponential backoff capped at five minutes, and `NWPathMonitor` retries when the
  network returns.
- A background task buys extra upload time after backgrounding.
- Duplicate concurrent uploads are guarded. Missing local files are dropped from the queue.
- Webview termination stops active recording, so native and UI state do not diverge.
- Interruptions (calls, Siri, alarms) and input route changes (unplugged headphones, lost
  Bluetooth mic) stop recording cleanly, to avoid capturing silence or the wrong input.

The React side is a controller and display. The native layer owns durable capture and upload.

## Data Model

`client/models/audio-recording/audio-recording.ts` tracks backend processing state apart from
note content: ID, status, creation time, optional completion time. `AudioRecordingStore` listens
to the graph's Firestore audio-recordings collection and exposes `isProcessing` and
`processingCount`. These are display aids only; the transcript lands in the daily note.

## What V2 Should Learn

The lesson is the reliability boundary, not the server architecture. V1 depends on
Reflect-hosted Firebase Storage and backend transcription, which does not fit V2's
no-Reflect-hosted-APIs and BYOK principles. What carries forward:

- Voice capture is a first-class mobile affordance, and OS-level entry points are part of its
  value.
- The raw recording needs a durable native-owned landing zone before any transcription.
- Recording must survive activation races, webview failure, backgrounding, network loss, and
  audio interruptions.
- Transcription preferences and privacy constraints must be explicit where audio leaves the
  device.
- The transcript flows into the daily note, the user's capture inbox.

The likely V2 shape: native capture into local durable storage, then app-owned BYOK
transcription and markdown insertion.

## Code Map

- `components/buttons/record-button.tsx`, `components/buttons/add-fab-button.tsx`: in-app entry
  points.
- `components/recording-modal/`: the modal (`recording-modal.tsx`), webview state, native-action
  listener, and preference bridge (`recording-view.ts`), and controls (`recording-controls.tsx`).
- `capacitor/recording.ts`, `capacitor/native-actions.ts`: TypeScript bridges.
- `ios/App/App/Capacitor Plugins/RecordingPlugin/RecordingPlugin.swift`: recording, Live
  Activity, upload queue, retries, interruptions.
- `ios/App/App/Capacitor Plugins/NativeActionsPlugin/NativeActionsPlugin.swift`: cold-start /
  reload action handshake.
- `ios/App/App/AppDelegate.swift`: URL scheme, quick action, and lifecycle hooks.
- `ios/App/Intents/Intents.swift`, `ios/App/Intents/LiveActivityIntents.swift`: Siri start and
  Live Activity stop.
- `ios/App/App Widget/RecordingActivityWidget.swift`: Live Activity / Dynamic Island UI.
- `client/models/audio-recording/`, `services/api/audio-recordings.ts`: processing status model
  and Firestore listener.
