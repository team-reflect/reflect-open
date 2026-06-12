import { errorMessage, isAppError } from '../errors'
import { pickTranscriptionConfig, type AiProvidersState } from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import { transcribeAudio } from '../ai/transcribe'
import { readNote, writeNote } from '../graph/commands'
import { dailyPath } from '../graph/paths'
import { appendBlock } from '../markdown/edit'
import { getSecret } from '../secrets/keychain'

/**
 * Capture actions for audio memos (the first of the `actions/` capture
 * family — Plan 11's link capture will sit alongside). The whole flow lives
 * here, not in the UI: record (host) → transcribe (BYOK provider) → append
 * to today's daily note.
 *
 * Privacy: only the freshly captured audio is sent to the provider — never
 * any note content — and the transcript is written locally, so recording is
 * allowed even when today's note is `private: true`.
 */

/**
 * The step to (re-)run. A failure hands back the payload for the step that
 * failed, so a retry after a successful transcription re-runs the append
 * only — transcription is never paid for twice.
 */
export type AudioMemoResume =
  | { kind: 'transcribe'; audio: Blob; mimeType: string }
  | { kind: 'append'; text: string }

/**
 * Every expected failure is data, not a throw: `resume` is what a retry
 * should re-run, or `null` when retrying cannot help (an empty transcript).
 */
export type SaveAudioMemoOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string; resume: AudioMemoResume | null }

export interface SaveAudioMemoInput {
  /** A fresh recording, or the resume payload from a prior failure. */
  payload: AudioMemoResume
  /** The configured-provider state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** The target day (local ISO date) — resolved at save time, not record time. */
  date: string
  /** `GraphInfo.generation` — pins the write to the issuing graph. */
  generation: number
  /** Host transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
}

/** Transcribe + append one audio memo, reporting failures as resumable data. */
export async function saveAudioMemo(input: SaveAudioMemoInput): Promise<SaveAudioMemoOutcome> {
  let step = input.payload
  if (step.kind === 'transcribe') {
    const transcribed = await transcribeStep(step, input.providers, input.fetchFn)
    if (!transcribed.ok) {
      return transcribed
    }
    step = { kind: 'append', text: transcribed.text }
  }
  try {
    await appendToDailyNote({ date: input.date, text: step.text, generation: input.generation })
  } catch (cause) {
    return { ok: false, message: errorMessage(cause), resume: step }
  }
  return { ok: true, text: step.text }
}

type TranscribeStepOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string; resume: AudioMemoResume | null }

async function transcribeStep(
  payload: AudioMemoResume & { kind: 'transcribe' },
  providers: AiProvidersState,
  fetchFn: typeof fetch | undefined,
): Promise<TranscribeStepOutcome> {
  // Re-picked on every run (not once at record time): a retry after the user
  // fixes their provider configuration should see the fix.
  const config = pickTranscriptionConfig(providers)
  if (config === null) {
    return { ok: false, message: 'No OpenAI or Gemini model is configured.', resume: payload }
  }
  const apiKey = await getSecret(aiKeySecretName(config.id))
  if (apiKey === null) {
    return {
      ok: false,
      message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      resume: payload,
    }
  }
  let text: string
  try {
    text = await transcribeAudio({
      provider: config.provider,
      apiKey,
      audio: payload.audio,
      mimeType: payload.mimeType,
      fetchFn,
    })
  } catch (cause) {
    return { ok: false, message: errorMessage(cause), resume: payload }
  }
  if (text === '') {
    return {
      ok: false,
      message: 'The recording came back empty — nothing to append.',
      resume: null,
    }
  }
  return { ok: true, text }
}

export interface AppendToDailyNoteInput {
  /** The target day, as a local ISO date (`YYYY-MM-DD`). */
  date: string
  /** The block to append (an audio-memo transcript). */
  text: string
  /** `GraphInfo.generation` — pins the write to the issuing graph. */
  generation: number
}

/**
 * Append `text` to the day's daily note, creating the file when the day has
 * none yet — capture must never depend on the note already existing. The
 * write goes straight to disk: the watcher reindexes it, and an open editor
 * session reconciles it like any external change (clean buffers reload in
 * place; dirty ones park a conflict rather than being clobbered).
 */
export async function appendToDailyNote(input: AppendToDailyNoteInput): Promise<void> {
  const path = dailyPath(input.date)
  let source = ''
  try {
    source = await readNote(path)
  } catch (cause) {
    if (!isAppError(cause) || cause.kind !== 'notFound') {
      throw cause
    }
  }
  await writeNote(path, appendBlock(source, input.text), input.generation)
}
