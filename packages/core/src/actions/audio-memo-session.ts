import { z } from 'zod'
import { errorMessage, isAppError } from '../errors'
import { TRANSCRIPTION_MAX_SEGMENT_BYTES, type TranscriptionProvider } from '../ai/provider-config'
import { transcribeAudio } from '../ai/transcribe'
import { isTranscriptionOversize, isTranscriptionRejected } from '../ai/transcribe-http'
import { base64ToBytes } from '../lib/base64'
import {
  readAsset,
  readAssetBinary,
  readTranscriptCache,
  writeTranscriptCache,
} from '../graph/commands'
import { hasBinaryIpc } from '../ipc/bridge'
import type { AudioMemoIdentity } from './audio-memo'

/**
 * Session semantics for segmented audio memos. One recording session rotates
 * the recorder every {@link AUDIO_MEMO_SEGMENT_MS}, landing each finished
 * segment as its own complete audio file (`<base>.part-NNN.<ext>`, the last
 * one `-end`-marked). Segment-sized files keep every provider's single
 * request comfortable no matter how long the meeting ran; the note and the
 * daily-note backlink stay per *session*, so the tombstone contract is
 * unchanged from single-file memos (which parse as one-part closed sessions).
 *
 * Everything here is pure bookkeeping over already-parsed parts — grouping,
 * closed/ready judgement, transcript stitching, and the codec for the
 * per-part transcript cache under `.reflect/transcripts/`. The cache is what
 * makes retries cheap: a pass that dies at part 7 of 12 never re-bills the
 * first six.
 */

/**
 * Rotate the recorder after this much audio; each segment is one file.
 * Twenty minutes is the ceiling the provider walls allow with margin: the
 * OpenAI 4o transcription models refuse audio over 1500 s, and a throttled
 * webview timer can overshoot the rotation tick, so the target must sit
 * well under 25 minutes. At the requested 64 kbps a segment is ~9.6 MB;
 * even an encoder that ignores the bitrate hint (~128 kbps) stays under
 * OpenAI's 25 MiB request cap at ~19.2 MB.
 */
export const AUDIO_MEMO_SEGMENT_MS = 20 * 60_000

/** Auto-stop cap for one recording session: four hours covers most meetings. */
export const AUDIO_MEMO_MAX_DURATION_MS = 4 * 60 * 60_000

/**
 * Crash fallback for "is this session still being recorded?": with no `-end`
 * marker, a session whose newest segment is older than a segment plus this
 * slack cannot still be live — the recorder would have rotated by now.
 */
const SESSION_CLOSE_SLACK_MS = 10 * 60_000

/** One recording segment, parsed from its `audio-memos/` listing entry. */
export interface AudioMemoPart {
  /** The session every sibling segment shares. */
  memo: AudioMemoIdentity
  /** Graph-relative path of this segment's audio file. */
  path: string
  /** 1-based position within the session. */
  part: number
  /** True on the final segment of a cleanly stopped session. */
  end: boolean
  /** iCloud eviction placeholder — the bytes are not local (Plan 21). */
  placeholder: boolean
  /** Listing size, for the transcription size guard. */
  sizeBytes: number
  /** Listing mtime, for the age-based close fallback. */
  modifiedMs: number
}

/** All known segments of one recording session, ordered by part number. */
export interface AudioMemoSession {
  memo: AudioMemoIdentity
  parts: AudioMemoPart[]
}

/** Group parsed parts into sessions, oldest session first. */
export function groupAudioMemoSessions(parts: AudioMemoPart[]): AudioMemoSession[] {
  const byBase = new Map<string, AudioMemoPart[]>()
  for (const part of parts) {
    const group = byBase.get(part.memo.base)
    if (group === undefined) {
      byBase.set(part.memo.base, [part])
    } else {
      group.push(part)
    }
  }
  return [...byBase]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, group]) => ({
      memo: group[0]!.memo,
      parts: group.sort((first, second) => first.part - second.part),
    }))
}

/**
 * Whether the session can still grow. Closed by the `-end` marker on a clean
 * stop, or by age when a crash kept the marker from ever being written.
 */
export function isSessionClosed(session: AudioMemoSession, nowMs: number): boolean {
  if (session.parts.some((part) => part.end)) {
    return true
  }
  const newest = Math.max(...session.parts.map((part) => part.modifiedMs))
  return nowMs - newest > AUDIO_MEMO_SEGMENT_MS + SESSION_CLOSE_SLACK_MS
}

/**
 * Whether the session can be assembled into its note: closed, every segment
 * from 1 to N present (a sync or eviction gap must not publish a note with a
 * silent hole), and every segment's bytes locally readable.
 */
export function isSessionReady(session: AudioMemoSession, nowMs: number): boolean {
  return (
    isSessionClosed(session, nowMs) &&
    session.parts.every((part, index) => part.part === index + 1 && !part.placeholder)
  )
}

/** A segment's terminal transcription result, as cached and as stitched. */
export type AudioMemoPartResult = { text: string } | { rejected: string }

/**
 * Per-part transcript cache, inside the graph but under `.reflect/` so the
 * watcher, indexer, and sync never see it. Derived data: deleting it costs a
 * re-transcription, never content.
 */
/** The cache entry's filename under `.reflect/transcripts/`. */
export function partTranscriptName(part: AudioMemoPart): string {
  return `${part.path.slice(part.path.lastIndexOf('/') + 1)}.json`
}

const partResultSchema = z.union([
  z.object({ text: z.string() }),
  z.object({ rejected: z.string() }),
])

/** Parse a cached result, or `null` for anything unrecognizable. */
export function decodePartResult(raw: string): AudioMemoPartResult | null {
  try {
    const parsed = partResultSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function encodePartResult(result: AudioMemoPartResult): string {
  return JSON.stringify(result)
}

/**
 * Stitch per-part results into one note body, in part order. Successful
 * segments join as paragraphs; a rejected segment contributes one failure
 * line so a single bad container never sinks the rest of the meeting. The
 * single-part wording matches the pre-segmentation notes byte for byte.
 */
export function stitchSessionTranscript(results: AudioMemoPartResult[]): string {
  if (results.length === 1) {
    const only = results[0]!
    return 'rejected' in only ? `Transcription failed: ${only.rejected}` : only.text
  }
  return results
    .map((result, index) =>
      'rejected' in result
        ? `Part ${index + 1} transcription failed: ${result.rejected}`
        : result.text,
    )
    .filter((section) => section !== '')
    .join('\n\n')
}

/** Read a segment's cached result, or `null` when none is stored yet. */
async function readPartTranscript(
  part: AudioMemoPart,
  generation: number,
): Promise<AudioMemoPartResult | null> {
  let raw: string
  try {
    raw = await readTranscriptCache(partTranscriptName(part), generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
  return decodePartResult(raw)
}

async function writePartTranscript(
  part: AudioMemoPart,
  result: AudioMemoPartResult,
  generation: number,
): Promise<void> {
  await writeTranscriptCache(partTranscriptName(part), encodePartResult(result), generation)
}

export interface TranscribeSessionPartsInput {
  session: AudioMemoSession
  provider: TranscriptionProvider
  apiKey: string
  generation: number
  fetchFn?: typeof fetch | undefined
  /** Abort gate, consulted before and after every slow await. */
  isStale: () => boolean
}

export type TranscribeSessionPartsOutcome =
  /** Every segment has a terminal result, in part order. */
  | { status: 'done'; results: AudioMemoPartResult[] }
  /** A segment's bytes aren't locally readable yet; assembly must wait. */
  | { status: 'partial' }
  | { status: 'stale' }
  /** A segment tripped the size guard — skip the session, never tombstone. */
  | { status: 'oversize' }

/**
 * Transcribe every uncached segment of one session, caching each result as
 * it lands. Cached segments cost nothing, so retries after a mid-session
 * failure only pay for what is still missing — and a session that is still
 * recording gets its finished segments transcribed while it grows. Throws on
 * unexpected provider errors (network, auth); the caller classifies them.
 */
export async function transcribeSessionParts(
  input: TranscribeSessionPartsInput,
): Promise<TranscribeSessionPartsOutcome> {
  const results: AudioMemoPartResult[] = []
  for (const part of input.session.parts) {
    if (input.isStale()) {
      return { status: 'stale' }
    }
    const cached = await readPartTranscript(part, input.generation)
    if (cached !== null) {
      results.push(cached)
      continue
    }
    if (part.placeholder) {
      return { status: 'partial' }
    }
    if (part.sizeBytes > TRANSCRIPTION_MAX_SEGMENT_BYTES) {
      return { status: 'oversize' }
    }
    if (part.sizeBytes === 0) {
      // A stop can flush an empty final segment purely as the end marker —
      // there is nothing to send a provider.
      await writePartTranscript(part, { text: '' }, input.generation)
      results.push({ text: '' })
      continue
    }
    const bytes = hasBinaryIpc()
      ? await readAssetBinary(part.path, input.generation)
      : base64ToBytes(await readAsset(part.path, input.generation))
    if (input.isStale()) {
      return { status: 'stale' }
    }
    let result: AudioMemoPartResult
    try {
      const text = await transcribeAudio({
        provider: input.provider,
        apiKey: input.apiKey,
        audio: new Blob([bytes], { type: part.memo.mimeType }),
        mimeType: part.memo.mimeType,
        fetchFn: input.fetchFn,
        isStale: input.isStale,
      })
      result = { text }
    } catch (cause) {
      if (isTranscriptionOversize(cause)) {
        return { status: 'oversize' }
      }
      if (!isTranscriptionRejected(cause)) {
        throw cause
      }
      // Terminal for these bytes: cache the refusal so it is one failure
      // line in the note, not a retry loop.
      result = { rejected: errorMessage(cause) }
    }
    if (input.isStale()) {
      return { status: 'stale' }
    }
    await writePartTranscript(part, result, input.generation)
    results.push(result)
  }
  return { status: 'done', results }
}
