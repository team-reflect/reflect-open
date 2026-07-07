# Reflect V1 Mobile: Audio Memos Grounding Brief

This document describes how audio memos work in the Reflect V1 mobile app, at a
high level, as a reference for the V2 rewrite. All file paths in this document
refer to the V1 mobile codebase (`~/repos/reflect-mobile`), not this repository.

For broader product context, see [Reflect V1 Overview](./reflect-v1-overview.md)
and [Reflect V1 Mobile Overview](./reflect-v1-mobile-overview.md).

## What It Is

Audio memos are the mobile app's fastest capture path: record speech on the phone,
upload it, have Reflect transcribe it, and append the resulting text to the daily
note. The feature is deliberately built as native iOS capture plus webview
presentation, because recording is expected to work from the lock screen, Siri,
widgets, quick actions, and other places where the React app may not be fully
alive yet.

The product model is simple for the user:

- Start recording from the app or an OS-level shortcut.
- Speak into the phone.
- Stop recording.
- Reflect uploads and processes the memo.
- The transcript appears in today's daily note through the normal sync pipeline.

The implementation is not simple. It is one of the clearest V1 mobile examples of
"critical capture must not depend on the webview."

## Entry Points

The user can start an audio memo from several places:

- The in-app record button and the floating `+` menu's microphone action.
- The lock-screen widget via the `reflect-widget://` URL.
- The home-screen quick action named "Record audio."
- Siri / App Intents with "Start recording in Reflect."
- The Live Activity / Dynamic Island, which displays recording status on the lock
  screen, shows elapsed time, and exposes a stop button on supported iOS versions.

Most OS-triggered entry points post a native `recordAudio` notification. The
`NativeActions` plugin stores the requested action until the webview has finished
setting up listeners, then fires it. The webview confirms the action after the
recording modal survives a short delay. This handshake is there because activating
the app from the outside could reload or crash the webview; the action should not
be lost or double-run.

## User Experience

In the app, recording opens as an Ionic modal backed by
`components/recording-modal/recording-modal.tsx` and
`components/recording-modal/recording-view.ts`.

Key behavior:

- Opening the modal requests push-notification permission, because V1 processing
  happens server-side and may complete later.
- The modal starts recording as soon as it is presented.
- Tapping or swiping outside the modal does not dismiss it; only the recording
  lifecycle closes it programmatically.
- Native audio metering streams into the webview and renders a live waveform.
- The control animates between idle and recording states.
- When recording stops, the app shows "Uploading and processing your audio memo."

The mobile UI does not expose an editor-like review step for the raw audio. The
memo is handed to the native upload pipeline, then the user waits for processing.
While backend records are `pending` or `processing`, the `AudioRecordingStore`
can show a processing count; the profile modal also shows a simple "Recordings to
upload" count for files still queued natively.

## Native Recording Pipeline

The core implementation lives in
`ios/App/App/Capacitor Plugins/RecordingPlugin/RecordingPlugin.swift`.

The pipeline is:

1. Configure an `AVAudioSession` for recording and request microphone permission if
   needed.
2. Create an `.m4a` file under `audio-uploads/`.
3. Record with `AVAudioRecorder` as AAC mono audio at 44.1 kHz.
4. Start timers for waveform metering and lock-screen / Live Activity duration
   updates.
5. Disable the idle timer while recording so the screen does not sleep.
6. On stop, add the file to a persisted pending-upload queue.
7. Upload directly from Swift to Firebase Storage.
8. Delete the local file only after upload succeeds.

The upload is native by design. A source comment explains the reason: when
recording ends, JavaScript may not wake up in time, especially if recording stops
because of a phone call or another system interruption. Swift therefore uploads
the file itself rather than notifying the webview and asking it to upload.

## Upload and Transcription

When Swift uploads the file to Firebase Storage, it attaches metadata that tells
the V1 backend how to process it:

- `processAs: audioRecording-v2`
- user ID and graph ID
- the target daily note ID for the current date
- native OAuth token details
- transcription prompt, formatting, and language preferences

Those transcription preferences are still owned by the webview preference store.
`RecordingView` reacts to preference changes and calls the native `Recording.setup`
bridge with `initialPrompt`, `transcriptionFormat`, and `language`, so Swift can
include the latest values in upload metadata.

After upload, the V1 backend transcribes the audio and applies the result to the
daily note. The mobile app receives the completed note update through the same
Firestore / SQLite / Yjs sync path as any other note change.

## Reliability Behavior

V1 mobile treats audio capture as a reliability-sensitive native subsystem:

- Pending uploads are persisted in shared defaults, so they survive app restarts.
- Upload retries use exponential backoff, capped at five minutes.
- `NWPathMonitor` retries queued uploads when the network returns.
- A background task buys extra upload time after the app backgrounds.
- Concurrent duplicate uploads of the same file are guarded.
- Missing local files are dropped from the queue rather than retried forever.
- Webview termination stops active recording so native and UI state do not diverge.
- Audio interruptions such as phone calls, Siri, or alarms stop recording cleanly.
- Input route changes, such as unplugging headphones or losing a Bluetooth mic,
  also stop recording to avoid capturing silence or the wrong input.

This means V1 recording is not merely "a React button that calls an API." The
React side is mainly a controller and display surface. The native layer owns the
durable capture and upload boundary.

## Data Model

The mobile app tracks backend audio-processing state separately from note content.
`client/models/audio-recording/audio-recording.ts` has a small model with an ID,
status, creation time, and optional completion time. `pending` and `processing`
statuses count as active work.

`AudioRecordingStore` listens to the graph's audio-recordings collection in
Firestore and exposes:

- `isProcessing`
- `processingCount`

These are presentation aids only. The transcript itself does not live in this
store; it lands in the daily note after backend processing and normal sync.

## What V2 Should Learn

The important V1 lesson is the reliability boundary, not the server architecture.
V1 depends on Reflect-hosted infrastructure: Firebase Storage receives the file,
the backend transcribes it, and the transcript syncs back into the daily note.
That path does not fit V2's no-Reflect-hosted-APIs and BYOK principles.

The mobile product lessons still carry forward:

- Voice capture is a first-class mobile affordance, not a settings-adjacent feature.
- OS-level entry points are part of the product value.
- The raw recording needs a durable native-owned landing zone before any
  transcription attempt.
- Recording must survive app activation races, webview failure, backgrounding,
  network loss, and audio-session interruptions.
- Transcription preferences and privacy constraints must be explicit at the
  boundary where audio leaves the device.
- The final transcript should flow into the daily note, because daily notes are
  the user's capture inbox.

For V2, the likely shape is "native capture into local durable storage, then
app-owned BYOK transcription and markdown insertion." That replaces V1's Firebase
upload and Reflect backend transcription while preserving the capture-first mobile
experience.

## Code Map

- `components/buttons/record-button.tsx` and
  `components/buttons/add-fab-button.tsx` — in-app recording entry points.
- `components/recording-modal/recording-modal.tsx` — Ionic recording modal.
- `components/recording-modal/recording-view.ts` — webview recording state,
  native-action listener, waveform events, and transcription-preference bridge.
- `components/recording-modal/recording-controls.tsx` — modal copy, waveform, and
  record/stop control.
- `capacitor/recording.ts` — TypeScript bridge interface for the native recording
  plugin.
- `capacitor/native-actions.ts` — TypeScript bridge interface for native-triggered
  actions.
- `ios/App/App/Capacitor Plugins/RecordingPlugin/RecordingPlugin.swift` — native
  recording, Live Activity updates, upload queue, retries, and interruption
  handling.
- `ios/App/App/Capacitor Plugins/NativeActionsPlugin/NativeActionsPlugin.swift` —
  cold-start / webview-reload action handshake.
- `ios/App/App/AppDelegate.swift` — URL scheme, quick action, and app lifecycle
  hooks that dispatch recording actions.
- `ios/App/Intents/Intents.swift` and
  `ios/App/Intents/LiveActivityIntents.swift` — Siri start and Live Activity stop
  intents.
- `ios/App/App Widget/RecordingActivityWidget.swift` — Live Activity / Dynamic
  Island recording UI.
- `client/models/audio-recording/` and `services/api/audio-recordings.ts` —
  backend processing status model and Firestore listener.
