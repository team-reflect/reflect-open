# Porting audio memos

**Status: ported.** This doc records how the v1 feature maps onto v2 and
what deliberately changed.

## What v1 did

v1 recorded a voice memo in the app, uploaded it for transcription on
Reflect's servers, and put the transcript in the daily note. Transcription
capacity was part of the paid plan.

## How v2 does it

Recording is local and transcription is bring-your-own-key. No audio
touches a Reflect server, because there isn't one.

- **Entry point.** The sidebar microphone control and a global shortcut
  (`mod+\`). Lifecycle: `apps/desktop/src/providers/audio-memo-provider.tsx`.
- **Capture is durable first.** A session runs until the user stops it,
  stored as twenty-minute segments. Each finished segment lands at once in
  `audio-memos/` as a complete file (`<base>.part-NNN.<ext>`, the last one
  `-end`-marked), streamed over raw binary IPC. A crash loses at most the
  current segment. Transcription is a separate, retryable step; it never
  loses audio. On iOS the recorder is native
  (`plugins/tauri-plugin-recording`): it rotates on the same schedule while
  backgrounded or locked, and Rust copies each segment into the graph
  file-to-file, so audio never enters webview memory. Because nothing stops
  a session on its own, a notification every thirty minutes says the
  microphone is still live (a toast with a stop control on desktop).
- **Transcription.** Per segment, then assembled per session. Segments fit
  every provider's single request, so long recordings need no provider
  large-file mechanism and work with OpenAI alone. Segment transcripts are
  cached under `.reflect/transcripts/` (a failed pass never re-bills
  finished segments, and segments transcribe while recording continues).
  Once the session is closed and gap-free, they are stitched into one note.
  Uses the user's OpenAI or Gemini key (`pickTranscriptionConfig` in
  `@reflect/core`; keys in the keychain via
  `apps/desktop/src-tauri/src/secrets.rs`). By default one best-effort
  small-model pass adds punctuation, paragraphs, light Markdown, and a
  title without changing meaning. With `Transcription auto-format` off, the
  pass makes only the title and the note keeps the raw transcript.
  Formatting failures fall back to raw text and a local title instead of
  retrying speech-to-text. The reconciler
  (`packages/core/src/audio/audio-memo-transcription-service.ts`) writes a
  transcript note, resolves or creates the `Audio memos` category note, and
  backlinks both from the daily note under `## [[Audio memos]]`. Pending
  memos retry in the background.
- **No key configured.** The mic button is disabled with a tooltip pointing
  at Settings; there is no metered tier to fall back to.

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
  explicit, user-initiated network call, documented in
  [docs/privacy.md](../privacy.md).
- `private: true` applies to note content; audio memos are captured before
  they belong to any note, so the flag has no bite at record time. A future
  "transcribe into a specific note" flow must respect it when the target is
  private.
