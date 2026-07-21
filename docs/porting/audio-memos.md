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
  keychain via `apps/desktop/src-tauri/src/secrets.rs`). By default, the fresh
  transcript receives one best-effort small-model pass that adds punctuation,
  paragraphs, light Markdown, and a title without changing its meaning. With
  `Transcription auto-format` disabled, that pass generates only the title and
  the note stores the raw provider transcript. Formatting failures also fall
  back to the raw text and a local title rather than retrying speech-to-text.
  The reconciler
  (`apps/desktop/src/lib/transcription-reconciler.ts`) writes a dedicated
  transcript note, resolves or creates the `Audio memos` category note, and
  backlinks both from the daily note under `## [[Audio memos]]`. Pending memos
  retry in the background.
- **No key configured.** The mic button is disabled with a tooltip pointing
  at Settings — there is no metered fallback tier to fall back to.

## v1 → v2 mapping

| v1                                       | v2                                                    |
| ---------------------------------------- | ----------------------------------------------------- |
| Upload to Reflect servers for transcription | Direct provider call with the user's own key       |
| Transcription quota tied to plan         | No quotas; provider bills the user directly           |
| Audio stored in the cloud account        | Audio is a file in the graph (`audio-memos/`), backed up by git like everything else |
| Works only online                        | Recording works offline; transcription catches up later |
| Optional transcript auto-formatting      | Default-on in the BYOK title pass; disable body formatting in Settings |

## Notes and follow-ups

- Sending audio and its fresh transcript to the configured providers is an
  explicit, user-initiated network call
  and is documented in [docs/privacy.md](../privacy.md).
- The `private: true` flag applies to note content; audio memos are captured
  before they belong to any note, so the flag has no bite at record time.
  If memos ever gain a "transcribe into a specific note" flow targeting a
  private note, the transcript-insertion step must respect the flag.
