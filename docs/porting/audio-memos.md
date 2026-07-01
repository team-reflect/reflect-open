# Porting audio memos

**Status: ported.** Audio memos are shipped in v2; this doc records how the
v1 feature maps onto the v2 implementation and what deliberately changed.

## What v1 did

v1 let users record a voice memo from the app; the audio was uploaded and
transcribed on Reflect's servers, and the transcript landed in the daily
note. Transcription capacity was part of the paid plan.

## How v2 does it

Recording is local and transcription is bring-your-own-key — no audio ever
touches a Reflect server, because there isn't one.

- **Entry point.** The microphone control in the sidebar, with a global
  shortcut (`mod+\`). Lifecycle lives in
  `apps/desktop/src/providers/audio-memo-provider.tsx`.
- **Capture is durable first.** The recording (max 10 minutes) is saved
  immediately into the graph's `audio-memos/` folder. Transcription is a
  separate, retryable step — a failed or missing transcription never loses
  the audio.
- **Transcription.** Runs against the user's own OpenAI or Gemini key
  (chosen by `pickTranscriptionConfig` in `@reflect/core`; keys in the OS
  keychain via `apps/desktop/src-tauri/src/secrets.rs`). The reconciler
  (`apps/desktop/src/lib/transcription-reconciler.ts`) writes the transcript
  into the daily note and retries pending memos in the background.
- **No key configured.** The mic button is disabled with a tooltip pointing
  at Settings — the app won't record audio it can never transcribe, and
  there is no metered fallback tier. Offline is the different case: with a
  key configured, recording works without a network and transcription
  catches up later.

## v1 → v2 mapping

| v1                                       | v2                                                    |
| ---------------------------------------- | ----------------------------------------------------- |
| Upload to Reflect servers for transcription | Direct provider call with the user's own key       |
| Transcription quota tied to plan         | No quotas; provider bills the user directly           |
| Audio stored in the cloud account        | Audio is a file in the graph (`audio-memos/`), backed up by git like everything else |
| Works only online                        | Recording works offline; transcription catches up later |

## Notes and follow-ups

- Sending audio to a provider is an explicit, user-initiated network call
  and is documented in [docs/privacy.md](../privacy.md).
- The `private: true` flag applies to note content; audio memos are captured
  before they belong to any note, so the flag has no bite at record time.
  If memos ever gain a "transcribe into a specific note" flow targeting a
  private note, the transcript-insertion step must respect the flag.
