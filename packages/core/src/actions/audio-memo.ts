import { errorMessage, isAppError, toAppError, type AppError } from '../errors'
import {
  pickProviderTranscriptionConfig,
  pickTranscriptionConfig,
  type AiProvidersState,
  type TranscriptionConfig,
} from '../ai/provider-config'
import { aiKeySecretName } from '../ai/secrets'
import {
  audioMemoEnrichmentConfig,
  pickAudioMemoEnrichmentConfig,
  type AudioMemoEnrichmentCredentials,
} from '../ai/audio-memo-title'
import { buildAudioMemoTranscript } from '../ai/audio-memo-transcript'
import { AUDIO_EXTENSION_BY_MIME, baseMimeType } from '../ai/audio-mime'
import { routeTranscription } from '../ai/transcription-routing'
import { base64ToBytes, bytesToBase64 } from '../lib/base64'
import {
  listDir,
  listFiles,
  readAsset,
  readAssetBinary,
  readNote,
  writeAsset,
  writeNote,
} from '../graph/commands'
import { writeAssetStreamed } from '../graph/assets'
import { AUDIO_MEMOS_DIR, audioMemoPath, dailyPath, notePath } from '../graph/paths'
import { appendUnderBacklinkedHeading, wikiLinkSafe } from '../markdown/edit'
import { getSecret } from '../secrets/keychain'
import { hasBinaryIpc } from '../ipc/bridge'
import { ensureBacklinkTarget } from './backlink-target'

/**
 * Capture actions for audio memos (the first of the `actions/` capture
 * family — Plan 11's link capture will sit alongside). The pipeline is
 * raw-first, like the capture-inbox spool: the recording itself is the durable
 * artifact, and transcription is async enrichment that can fail and retry freely.
 *
 * 1. **Capture** ({@link captureAudioMemo}): the recording is written to
 *    `audio-memos/audio-memo-<date>-<time>.<ext>` — local, instant, no
 *    network. The sync engine commits it like any other change.
 * 2. **Reconcile** ({@link reconcileAudioMemos}): a memo's transcription is a
 *    note with the **same basename** (`notes/<base>.md`). Any memo without
 *    one resolves or creates the `Audio memos` category note, is transcribed
 *    (BYOK provider), optionally formatted and named in one best-effort
 *    small-model pass, written to its transcription note, and backlinked from
 *    its day's daily note — transcript note first,
 *    because it carries the result: a failure between
 *    the two writes leaves an unlinked note, never a tombstoned memo whose
 *    transcript was dropped. A
 *    failed pass (offline, bad key) leaves the memo pending; the next
 *    trigger retries. Nothing is ever lost to a network error. A recording
 *    the provider *refuses* (an unsupported or corrupt container) is
 *    tombstoned with a failure note instead — retrying the same bytes can't
 *    help, and stopping would wedge every memo behind it. A recording too
 *    *large* for every configured provider is different: it's skipped, not
 *    tombstoned, because adding a Google entry (Files API) later makes it
 *    transcribable.
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
 * Privacy: the captured audio and its fresh transcript (for naming and optional
 * formatting) are sent to user-configured providers — never any existing note
 * content. All output is written locally, so recording is allowed even when the
 * daily note is `private: true`.
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
  /** The timestamp fallback title, before the transcript-derived name exists. */
  title: string
  /** Timestamp fallback alias for the daily-note link, e.g. `Audio memo 15:30`. */
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
async function writeAudioMemoAsset(path: string, audio: Blob, generation: number): Promise<void> {
  if (hasBinaryIpc()) {
    await writeAssetStreamed(path, audio, generation)
    return
  }
  // Browser dev's in-memory bridge has no binary transport; recordings there
  // are short enough for the base64 JSON route.
  await writeAsset(path, bytesToBase64(new Uint8Array(await audio.arrayBuffer())), generation)
}

export async function captureAudioMemo(
  input: CaptureAudioMemoInput,
): Promise<CaptureAudioMemoOutcome> {
  const memo = audioMemoIdentity(input.recordedAt, input.mimeType)
  try {
    await writeAudioMemoAsset(memo.audioPath, input.audio, input.generation)
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

/** A memo awaiting transcription, with the size its routing decision needs. */
export interface PendingAudioMemo {
  /** Everything derivable from the recording's basename. */
  memo: AudioMemoIdentity
  /**
   * Recording size on disk, from the directory listing — provider routing
   * (see `ai/transcription-routing`) decides on it *before* any bytes are
   * read, so an unroutable memo costs nothing per pass.
   */
  sizeBytes: number
}

/**
 * Memos awaiting transcription, oldest first: a recording under
 * `audio-memos/` with no same-named transcription note and no daily-note
 * backlink (the backlink is the tombstone — see the module doc). Every read
 * is pinned to `generation` — recordings, notes, and daily-note tombstones
 * must come from one graph session, never a mix across a switch.
 */
export async function listPendingAudioMemos(generation: number): Promise<PendingAudioMemo[]> {
  const [recordings, notes] = await Promise.all([
    listDir(AUDIO_MEMOS_DIR, generation),
    listFiles(generation),
  ])
  const existingNotes = new Set(notes.map((file) => file.path))
  const candidates = recordings
    // An iCloud-evicted recording lists under its logical name but its bytes
    // aren't local — reading it would abort the pass. It transcribes on a
    // later pass, once downloaded (Plan 21).
    .filter((file) => file.placeholder !== true)
    .map((file) => ({ memo: audioMemoFromPath(file.path), sizeBytes: file.size }))
    .filter((entry): entry is PendingAudioMemo => entry.memo !== null)
    .filter(({ memo }) => !existingNotes.has(memo.notePath))
    .sort((first, second) => first.memo.base.localeCompare(second.memo.base))
  const pending: PendingAudioMemo[] = []
  for (const entry of candidates) {
    if (!hasBacklink(await dailyNoteSource(entry.memo.date, generation), entry.memo)) {
      pending.push(entry)
    }
  }
  return pending
}

/**
 * The note declares its base name as an alias so the daily-note link
 * (`[[<base>|…]]`) resolves through the index — and keeps resolving if the
 * user renames the title.
 */
function transcriptionNote(memo: AudioMemoIdentity, title: string, body: string): string {
  return `---\naliases: [${memo.base}]\n---\n\n# ${title}\n\n[Recording](${memo.audioPath})\n\n${body}\n`
}

/** The category note every audio-memo section backlinks. */
const MEMOS_NOTE_TITLE = 'Audio memos'
/**
 * Append the memo's wikilink once under `## [[Audio memos]]`, creating the
 * heading and daily file as needed. The watcher reindexes the direct write;
 * open dirty editors park a conflict instead of being clobbered.
 */
async function ensureDailyBacklink(
  memo: AudioMemoIdentity,
  title: string,
  memosNoteTitle: string,
  generation: number,
): Promise<void> {
  const source = await dailyNoteSource(memo.date, generation)
  if (hasBacklink(source, memo)) {
    return
  }
  const displayTitle = wikiLinkSafe(title) || memo.title
  const link = `- [[${memo.base}|${displayTitle}]]`
  const updated = appendUnderBacklinkedHeading(source, memosNoteTitle, link, [MEMOS_NOTE_TITLE])
  await writeNote(dailyPath(memo.date), updated, generation)
}

/**
 * Why a reconcile pass ended with memos still pending. `config` = no capable
 * provider/key (self-heals when settings change); `stale` = the caller's
 * abort gate fired; `oversize` = a recording exceeds every configured
 * provider's byte budget (surfaced once — the fix is adding a Google entry,
 * whose Files API takes meeting-length audio); anything else is the failing
 * step's error kind (`network` while offline is the expected, silent case).
 */
export interface ReconcileStop {
  reason: 'config' | 'stale' | 'oversize' | AppError['kind']
  message: string
}

/**
 * Whether a {@link ReconcileStop} is an expected, self-healing stop that a
 * background controller should swallow rather than surface to the user:
 * `network` (offline — retries on the next trigger), `config` (no provider/key
 * yet — the work waits), or `stale` (a graph switch tore the pass down). Any
 * other reason is worth surfacing or logging — including `oversize`, which
 * needs the user to act (add a Google entry) before the memo can transcribe.
 * Shared by every background reconcile loop (capture, transcription, asset
 * descriptions).
 */
export function isSilentStop(stopped: ReconcileStop): boolean {
  return stopped.reason === 'network' || stopped.reason === 'config' || stopped.reason === 'stale'
}

export interface ReconcileAudioMemosInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** `GraphInfo.generation` — pins every write to the issuing graph. */
  generation: number
  /** Whether a best-effort text-model pass formats each fresh transcript. */
  formatTranscript: boolean
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
  /**
   * Memos left pending because no configured provider's byte budget fits the
   * recording. Not a tombstone: the memo transcribes on a later pass once a
   * capable (Google) entry is configured.
   */
  skipped: number
  /** Why memos remain pending, or `null` when the pass drained. */
  stopped: ReconcileStop | null
}

/**
 * Transcribe every pending memo: ensure the category target, read the
 * recording, transcribe, write the transcription note, then append the daily
 * backlink. The transcript note is written **first** — it carries the result,
 * so a failure between the
 * two writes leaves an unlinked note (recoverable from All Notes), never a
 * backlink-tombstoned memo whose transcript was dropped. A recording the
 * provider refuses gets a failure note (tombstoning it) and the pass moves
 * on; any other failure stops the pass — one memo's network or auth error
 * means the rest would fail the same way. Never throws.
 */
export async function reconcileAudioMemos(
  input: ReconcileAudioMemosInput,
): Promise<ReconcileAudioMemosOutcome> {
  let pending: PendingAudioMemo[]
  try {
    pending = await listPendingAudioMemos(input.generation)
  } catch (cause) {
    return {
      pending: 0,
      transcribed: 0,
      rejected: 0,
      skipped: 0,
      stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
    }
  }
  input.onPending?.(pending.length)
  if (pending.length === 0) {
    return { pending: 0, transcribed: 0, rejected: 0, skipped: 0, stopped: null }
  }

  // Re-picked on every pass (not once at record time): a pass after the user
  // fixes their model configuration must see the fix.
  const config = pickTranscriptionConfig(input.providers)
  if (config === null) {
    return {
      pending: pending.length,
      transcribed: 0,
      rejected: 0,
      skipped: 0,
      stopped: { reason: 'config', message: 'No OpenAI or Gemini model is configured.' },
    }
  }
  const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
  if (apiKey === null) {
    return {
      pending: pending.length,
      transcribed: 0,
      rejected: 0,
      skipped: 0,
      stopped: {
        reason: 'config',
        message: `The API key for the configured ${config.provider} model is missing from the keychain.`,
      },
    }
  }
  const enrichmentConfig = pickAudioMemoEnrichmentConfig(input.providers)
  const enrichmentApiKey =
    enrichmentConfig === null
      ? null
      : enrichmentConfig.id === config.id
        ? apiKey
        : await getSecret(aiKeySecretName(enrichmentConfig.id)).catch(() => null)
  const fallbackEnrichmentConfig = audioMemoEnrichmentConfig(config)
  const enrichmentCredentials: AudioMemoEnrichmentCredentials | null =
    enrichmentConfig !== null && enrichmentApiKey !== null
      ? { config: enrichmentConfig, apiKey: enrichmentApiKey }
      : fallbackEnrichmentConfig !== null
        ? { config: fallbackEnrichmentConfig, apiKey }
        : null

  // Long-recording routing (`ai/transcription-routing`): a memo the picked
  // provider can't fit routes to a configured Google entry; with none it's
  // *skipped* (left pending), never tombstoned — adding a Google key later
  // transcribes it. Keys are fetched lazily and memoized per entry, so a
  // pass with no oversized memos never touches the keychain twice.
  const googleConfig = pickProviderTranscriptionConfig(input.providers, 'google')
  const apiKeys = new Map<string, string | null>([[config.id, apiKey]])
  let skippedForMissingGoogleKey = false
  /** Route a recording of `bytes` with its entry's key; `null` = skip the memo. */
  const resolveTarget = async (
    bytes: number,
  ): Promise<{ config: TranscriptionConfig; apiKey: string } | null> => {
    const routed = routeTranscription(input.providers, config, bytes)
    if (routed === null) {
      return null
    }
    if (!apiKeys.has(routed.id)) {
      apiKeys.set(routed.id, await getSecret(aiKeySecretName(routed.id)).catch(() => null))
    }
    const routedKey = apiKeys.get(routed.id) ?? null
    if (routedKey === null) {
      // Only a fallback entry can land here (the preferred key is pre-seeded
      // and non-null) — remember why we skipped, so the surfaced hint names
      // the missing key rather than blaming the recording's size.
      skippedForMissingGoogleKey = true
      return null
    }
    return { config: routed, apiKey: routedKey }
  }

  let transcribed = 0
  let rejected = 0
  let skipped = 0
  let memosNoteTitle: string | null = null
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
    skipped,
    stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
  })
  for (const { memo, sizeBytes } of pending) {
    if (stale()) {
      return stalled()
    }
    try {
      let target = await resolveTarget(sizeBytes)
      if (target === null) {
        skipped += 1
        continue
      }
      if (stale()) return stalled()
      memosNoteTitle ??= await ensureBacklinkTarget(MEMOS_NOTE_TITLE, input.generation)
      if (stale()) return stalled()
      const bytes = hasBinaryIpc()
        ? await readAssetBinary(memo.audioPath, input.generation)
        : base64ToBytes(await readAsset(memo.audioPath, input.generation))
      const audio = new Blob([bytes], { type: memo.mimeType })
      if (audio.size > sizeBytes) {
        // The listing raced a rewrite and undersold the recording. Re-route
        // on what was actually read: an oversize file must never reach a
        // provider that will refuse it, because refusal tombstones.
        target = await resolveTarget(audio.size)
        if (target === null) {
          skipped += 1
          continue
        }
      }
      if (stale()) {
        return stalled()
      }
      const note = await buildAudioMemoTranscript({
        audio,
        mimeType: memo.mimeType,
        config: target.config,
        apiKey: target.apiKey,
        enrichmentCredentials,
        formatTranscript: input.formatTranscript,
        fallbackTitle: memo.title,
        fetchFn: input.fetchFn,
        isStale: stale,
      })
      if (note.status === 'stale' || stale()) {
        return stalled()
      }
      await writeNote(memo.notePath, transcriptionNote(memo, note.title, note.body), input.generation)
      await ensureDailyBacklink(memo, note.title, memosNoteTitle, input.generation)
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
        skipped,
        stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) },
      }
    }
  }
  return {
    pending: pending.length,
    transcribed,
    rejected,
    skipped,
    stopped:
      skipped === 0
        ? null
        : {
            reason: 'oversize',
            message: oversizeStopMessage(googleConfig !== null, skippedForMissingGoogleKey),
          },
  }
}

/**
 * The surfaced hint when memos were skipped as unroutable — specific about
 * the actual remedy: add a Google entry, fix its missing key, or (the
 * practically unreachable case) accept that no provider takes a file this
 * large.
 */
function oversizeStopMessage(hasGoogleEntry: boolean, missingGoogleKey: boolean): string {
  if (!hasGoogleEntry) {
    return 'A recording is too long for OpenAI transcription. Add a Google Gemini model in Settings to transcribe long memos.'
  }
  if (missingGoogleKey) {
    return 'A recording needs the configured Google Gemini model to transcribe, but its API key is missing from the keychain.'
  }
  return 'A recording is too large for the configured transcription providers.'
}
