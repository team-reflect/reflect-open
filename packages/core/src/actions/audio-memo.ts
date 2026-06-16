import { errorMessage, isAppError, toAppError, type AppError } from '../errors'
import {
  pickTranscriptionConfig,
  type AiProvidersState,
  type TranscriptionProvider,
} from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import {
  AUDIO_EXTENSION_BY_MIME,
  base64ToBytes,
  baseMimeType,
  bytesToBase64,
  isTranscriptionRejected,
  transcribeAudio,
} from '../ai/transcribe'
import { listDir, listFiles, readAsset, readNote, writeAsset, writeNote } from '../graph/commands'
import { AUDIO_MEMOS_DIR, audioMemoPath, dailyPath, notePath } from '../graph/paths'
import { appendBlock } from '../markdown/edit'
import { getSecret } from '../secrets/keychain'

/**
 * Capture actions for audio memos (the first of the `actions/` capture
 * family — Plan 11's link capture will sit alongside). The pipeline is
 * raw-first, like the capture-inbox spool (see
 * `docs/spikes/link-capture-bridge.md`): the recording itself is the durable
 * artifact, transcription is async enrichment that can fail and retry freely.
 *
 * 1. **Capture** ({@link captureAudioMemo}): the recording is written to
 *    `audio-memos/audio-memo-<date>-<time>.<ext>` — local, instant, no
 *    network. The sync engine commits it like any other change.
 * 2. **Reconcile** ({@link reconcileAudioMemos}): a memo's transcription is a
 *    note with the **same basename** (`notes/<base>.md`). Any memo without
 *    one is transcribed (BYOK provider), its transcription note written, and
 *    a backlink appended to its day's daily note — note first, because it
 *    carries the transcript: a failure between the two writes leaves an
 *    unlinked note, never a tombstoned memo whose transcript was dropped. A
 *    failed pass (offline, bad key) leaves the memo pending; the next
 *    trigger retries. Nothing is ever lost to a network error. A recording
 *    the provider *refuses* (oversized, unsupported container) is tombstoned
 *    with a failure note instead — retrying the same bytes can't help, and
 *    stopping would wedge every memo behind it.
 *
 * Deleting a transcription note does **not** resurrect it: the daily-note
 * backlink doubles as the tombstone (a memo is only pending while *neither*
 * its note nor its backlink exists). Deleting both regenerates the
 * transcription on the next pass — the documented way to redo one. The
 * backlink targets the memo's *base name*, declared as a frontmatter alias
 * on the transcription note: bases are unique per recording, so two memos
 * stopped within the same second (whose display titles collide) can never
 * tombstone each other, and the link survives a note-title rename.
 *
 * Privacy: only the captured audio is sent to the provider — never any note
 * content — and all transcription output is written locally, so recording is
 * allowed even when the daily note is `private: true`.
 */

/** Everything derivable from a memo's shared basename. */
export interface AudioMemoIdentity {
  /**
   * The shared basename, e.g. `audio-memo-2026-06-11-153022-845` — also the
   * daily-note wikilink target, resolvable through the transcription note's
   * frontmatter alias.
   */
  base: string
  /** Local ISO day it was recorded — the daily note that backlinks it. */
  date: string
  /** The transcription note's title (its H1). Not unique within a second. */
  title: string
  /** Short display alias for the daily-note link, e.g. `Audio memo 15:30`. */
  alias: string
  /** Graph-relative path of the recording under `audio-memos/`. */
  audioPath: string
  /** Graph-relative path of the transcription note, `notes/<base>.md`. */
  notePath: string
  /** The recording's MIME type, as stored (derived from the extension). */
  mimeType: string
}

/** `audio/mp4` ← `m4a` etc. — the inverse of the storage-naming map. */
const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(AUDIO_EXTENSION_BY_MIME).map(([mime, extension]) => [extension, mime]),
)

/**
 * `audio-memos/(audio-memo-<date>-<hhmmss>-<ms>).<ext>`. Milliseconds make
 * back-to-back recordings collision-free; the title drops them.
 */
const MEMO_PATH_RE =
  /^audio-memos\/(audio-memo-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})-\d{3})\.([a-z0-9]+)$/

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function buildIdentity(
  base: string,
  date: string,
  hours: string,
  minutes: string,
  seconds: string,
  extension: string,
): AudioMemoIdentity {
  return {
    base,
    date,
    title: `Audio memo ${date} ${hours}:${minutes}:${seconds}`,
    alias: `Audio memo ${hours}:${minutes}`,
    audioPath: audioMemoPath(`${base}.${extension}`),
    notePath: notePath(base),
    mimeType: MIME_BY_EXTENSION[extension] ?? 'audio/mp4',
  }
}

/** The identity a fresh recording will be stored under (local time). */
export function audioMemoIdentity(recordedAt: Date, mimeType: string): AudioMemoIdentity {
  const date = `${recordedAt.getFullYear()}-${pad(recordedAt.getMonth() + 1, 2)}-${pad(recordedAt.getDate(), 2)}`
  const hours = pad(recordedAt.getHours(), 2)
  const minutes = pad(recordedAt.getMinutes(), 2)
  const seconds = pad(recordedAt.getSeconds(), 2)
  const base = `audio-memo-${date}-${hours}${minutes}${seconds}-${pad(recordedAt.getMilliseconds(), 3)}`
  const extension = AUDIO_EXTENSION_BY_MIME[baseMimeType(mimeType)] ?? 'm4a'
  return buildIdentity(base, date, hours, minutes, seconds, extension)
}

/**
 * Recover a memo's identity from its recording path, or `null` for anything
 * that isn't a well-formed memo recording (a stray file dropped into
 * `audio-memos/` is never touched — reconciliation must not transcribe
 * arbitrary user files).
 */
export function audioMemoFromPath(path: string): AudioMemoIdentity | null {
  const match = MEMO_PATH_RE.exec(path)
  if (match === null) {
    return null
  }
  const [, base, date, hours, minutes, seconds, extension] = match
  if (
    base === undefined ||
    date === undefined ||
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined ||
    extension === undefined
  ) {
    return null
  }
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    return null
  }
  try {
    dailyPath(date) // calendar-validates the date the same way the backlink will
  } catch {
    return null
  }
  return buildIdentity(base, date, hours, minutes, seconds, extension)
}

export interface CaptureAudioMemoInput {
  /** The recording, as the recorder produced it. */
  audio: Blob
  /** The recording's MIME type, possibly with codec parameters. */
  mimeType: string
  /** When the recording stopped — names the asset and picks the daily note. */
  recordedAt: Date
  /** `GraphInfo.generation` — pins the write to the issuing graph. */
  generation: number
}

/** Expected failures are data: the caller retries with the same recording. */
export type CaptureAudioMemoOutcome =
  | { ok: true; memo: AudioMemoIdentity }
  | { ok: false; message: string }

/**
 * Persist one recording into the graph — the durable step, no network. The
 * transcription happens later, in {@link reconcileAudioMemos}.
 */
export async function captureAudioMemo(
  input: CaptureAudioMemoInput,
): Promise<CaptureAudioMemoOutcome> {
  const memo = audioMemoIdentity(input.recordedAt, input.mimeType)
  try {
    const encoded = bytesToBase64(new Uint8Array(await input.audio.arrayBuffer()))
    await writeAsset(memo.audioPath, encoded, input.generation)
  } catch (cause) {
    return { ok: false, message: errorMessage(cause) }
  }
  return { ok: true, memo }
}

/** The day's note source at `generation`, where "no note yet" reads as empty. */
async function dailyNoteSource(date: string, generation: number): Promise<string> {
  try {
    return await readNote(dailyPath(date), generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

/**
 * Matches the plain and aliased form of the memo's backlink. The probe is the
 * memo's base, never its display title — titles have second precision and a
 * sibling memo from the same second must not read as this memo's tombstone.
 */
function hasBacklink(source: string, memo: AudioMemoIdentity): boolean {
  return source.includes(`[[${memo.base}`)
}

/**
 * Memos awaiting transcription, oldest first: a recording under
 * `audio-memos/` with no same-named transcription note and no daily-note
 * backlink (the backlink is the tombstone — see the module doc). Every read
 * is pinned to `generation` — recordings, notes, and daily-note tombstones
 * must come from one graph session, never a mix across a switch.
 */
export async function listPendingAudioMemos(generation: number): Promise<AudioMemoIdentity[]> {
  const [recordings, notes] = await Promise.all([
    listDir(AUDIO_MEMOS_DIR, generation),
    listFiles(generation),
  ])
  const existingNotes = new Set(notes.map((file) => file.path))
  const candidates = recordings
    .map((file) => audioMemoFromPath(file.path))
    .filter((memo): memo is AudioMemoIdentity => memo !== null)
    .filter((memo) => !existingNotes.has(memo.notePath))
    .sort((first, second) => first.base.localeCompare(second.base))
  const pending: AudioMemoIdentity[] = []
  for (const memo of candidates) {
    if (!hasBacklink(await dailyNoteSource(memo.date, generation), memo)) {
      pending.push(memo)
    }
  }
  return pending
}

/**
 * The note declares its base name as an alias so the daily-note link
 * (`[[<base>|…]]`) resolves through the index — and keeps resolving if the
 * user renames the title.
 */
function transcriptionNote(memo: AudioMemoIdentity, body: string): string {
  return `---\naliases: [${memo.base}]\n---\n\n# ${memo.title}\n\n[Recording](${memo.audioPath})\n\n${body}\n`
}

/**
 * The note body for one memo: the transcript, a placeholder for silence, or
 * — when the provider refuses the recording itself — a failure notice that
 * tombstones the memo. Anything transient (offline, auth, rate limit)
 * rethrows and stops the pass.
 */
async function memoNoteBody(input: {
  audio: Blob
  memo: AudioMemoIdentity
  provider: TranscriptionProvider
  apiKey: string
  fetchFn?: typeof fetch | undefined
}): Promise<{ body: string; rejected: boolean }> {
  try {
    const text = await transcribeAudio({
      provider: input.provider,
      apiKey: input.apiKey,
      audio: input.audio,
      mimeType: input.memo.mimeType,
      fetchFn: input.fetchFn,
    })
    return { body: text === '' ? 'No speech detected.' : text, rejected: false }
  } catch (cause) {
    if (!isTranscriptionRejected(cause)) {
      throw cause
    }
    return { body: `Transcription failed: ${errorMessage(cause)}`, rejected: true }
  }
}

/**
 * Append the memo's wikilink to its day's daily note, once — creating the
 * file when the day has none yet (capture must never depend on the note
 * already existing). The write goes straight to disk: the watcher reindexes
 * it, and an open editor session reconciles it like any external change
 * (clean buffers reload in place; dirty ones park a conflict rather than
 * being clobbered).
 */
async function ensureDailyBacklink(memo: AudioMemoIdentity, generation: number): Promise<void> {
  const source = await dailyNoteSource(memo.date, generation)
  if (hasBacklink(source, memo)) {
    return
  }
  const link = `[[${memo.base}|${memo.alias}]]`
  await writeNote(dailyPath(memo.date), appendBlock(source, link), generation)
}

/**
 * Why a reconcile pass ended with memos still pending. `config` = no capable
 * provider/key (self-heals when settings change); `stale` = the caller's
 * abort gate fired; anything else is the failing step's error kind
 * (`network` while offline is the expected, silent case).
 */
export interface ReconcileStop {
  reason: 'config' | 'stale' | AppError['kind']
  message: string
}

export interface ReconcileAudioMemosInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every write to the issuing graph. */
  generation: number
  /** Host transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between memos (graph switch / unmount). */
  isStale?: () => boolean
  /** Observes how many memos need transcription, before work starts. */
  onPending?: (count: number) => void
}

export interface ReconcileAudioMemosOutcome {
  /** Memos that had no transcription when the pass started. */
  pending: number
  /** Memos this pass transcribed and backlinked. */
  transcribed: number
  /** Memos whose recording the provider refused — tombstoned with a failure note. */
  rejected: number
  /** Why memos remain pending, or `null` when the pass drained. */
  stopped: ReconcileStop | null
}

/**
 * Transcribe every pending memo: read the recording back, transcribe, write
 * the transcription note, then append the daily-note backlink. The note is
 * written **first** — it carries the transcript, so a failure between the
 * two writes leaves an unlinked note (recoverable from All Notes), never a
 * backlink-tombstoned memo whose transcript was dropped. A recording the
 * provider refuses gets a failure note (tombstoning it) and the pass moves
 * on; any other failure stops the pass — one memo's network or auth error
 * means the rest would fail the same way. Never throws.
 */
export async function reconcileAudioMemos(
  input: ReconcileAudioMemosInput,
): Promise<ReconcileAudioMemosOutcome> {
  let pending: AudioMemoIdentity[]
  try {
    pending = await listPendingAudioMemos(input.generation)
  } catch (cause) {
    return {
      pending: 0,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
    }
  }
  input.onPending?.(pending.length)
  if (pending.length === 0) {
    return { pending: 0, transcribed: 0, rejected: 0, stopped: null }
  }

  // Re-picked on every pass (not once at record time): a pass after the user
  // fixes their model configuration must see the fix.
  const config = pickTranscriptionConfig(input.providers)
  if (config === null) {
    return {
      pending: pending.length,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'config', message: 'No OpenAI or Gemini model is configured.' },
    }
  }
  const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
  if (apiKey === null) {
    return {
      pending: pending.length,
      transcribed: 0,
      rejected: 0,
      stopped: {
        reason: 'config',
        message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      },
    }
  }

  let transcribed = 0
  let rejected = 0
  // The gate is consulted again after every slow await (the asset read, the
  // provider call), not just per memo: a graph switch mid-transcription must
  // not bill another provider call or touch any note. Reads and writes are
  // additionally generation-pinned in Rust, so even the unguardable gap
  // between a gate check and the IPC call cannot cross graphs.
  const stale = (): boolean => input.isStale?.() === true
  const stalled = (): ReconcileAudioMemosOutcome => ({
    pending: pending.length,
    transcribed,
    rejected,
    stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
  })
  for (const memo of pending) {
    if (stale()) {
      return stalled()
    }
    try {
      const audio = new Blob([base64ToBytes(await readAsset(memo.audioPath, input.generation))], {
        type: memo.mimeType,
      })
      if (stale()) {
        return stalled()
      }
      const note = await memoNoteBody({
        audio,
        memo,
        provider: config.provider,
        apiKey,
        fetchFn: input.fetchFn,
      })
      if (stale()) {
        return stalled()
      }
      await writeNote(memo.notePath, transcriptionNote(memo, note.body), input.generation)
      await ensureDailyBacklink(memo, input.generation)
      if (note.rejected) {
        rejected += 1
      } else {
        transcribed += 1
      }
    } catch (cause) {
      return {
        pending: pending.length,
        transcribed,
        rejected,
        stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
      }
    }
  }
  return { pending: pending.length, transcribed, rejected, stopped: null }
}

