import { formatDate, formatIsoDate } from '@reflect/utils'
import { AUDIO_EXTENSION_BY_MIME, baseMimeType } from '../ai/transcription-service.ts'
import { type FileStamp, formatFileStamp, parseFileStamp } from '../lib/file-stamp.ts'
import { audioMemoPath, notePath } from '../graph/paths.ts'
import type { AudioMemoIdentity } from './audio-memo-session.ts'

/**
 * Names and paths of audio memos: the identity of a recording session, and
 * the stored path of each of its segments under `audio-memos/`. The capture
 * and transcription pipeline over them is `AudioMemoService`
 * (`audio/audio-memo-service`).
 */

/**
 * `audio/mp4` ← `m4a` etc. — the inverse of the storage-naming map.
 */
const MIME_BY_EXTENSION: Record<string, string> = Object.fromEntries(
  Object.entries(AUDIO_EXTENSION_BY_MIME).map(([mime, extension]) => [extension, mime]),
)

/**
 * `audio-memos/(audio-memo-<date>-<hhmmss>-<ms>)[.part-NNN[-end]].<ext>`.
 * Milliseconds make back-to-back recordings collision-free; the title drops
 * them. The optional `part` suffix is a session segment (see
 * `audio-memo-session`): `-end` marks the final segment of a cleanly stopped
 * session, and a legacy suffix-free file reads as a one-part closed session.
 * Part numbers are zero-padded to three digits and grow past it: a session
 * has no duration cap, so `part-1000` must parse like `part-999`.
 */
const MEMO_PATH_RE =
  /^audio-memos\/(audio-memo-(\d{4}-\d{2}-\d{2}-\d{6}-\d{3}))(?:\.part-(\d{3,})(-end)?)?\.([a-z0-9]+)$/

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function buildIdentity(
  base: string,
  { date, time }: FileStamp,
  extension: string,
): AudioMemoIdentity {
  return {
    base,
    date,
    title: `Audio memo ${date} ${time}`,
    alias: `Audio memo ${time.slice(0, 5)}`,
    audioPath: audioMemoPath(`${base}.${extension}`),
    notePath: notePath(base),
    mimeType: MIME_BY_EXTENSION[extension] ?? 'audio/mp4',
  }
}

/**
 * The identity a fresh recording will be stored under (local time).
 */
export function audioMemoIdentity(recordedAt: Date, mimeType: string): AudioMemoIdentity {
  const stamp = formatFileStamp(recordedAt)
  const extension = AUDIO_EXTENSION_BY_MIME[baseMimeType(mimeType)] ?? 'm4a'
  const fields = { date: formatIsoDate(recordedAt), time: formatDate(recordedAt, 'HH:mm:ss') }
  return buildIdentity(`audio-memo-${stamp}`, fields, extension)
}

/**
 * Recover a memo's identity from its recording path, or `null` for anything
 * that isn't a well-formed memo recording (a stray file dropped into
 * `audio-memos/` is never touched — reconciliation must not transcribe
 * arbitrary user files).
 */
export function audioMemoFromPath(path: string): AudioMemoIdentity | null {
  return audioMemoPartFromPath(path)?.memo ?? null
}

/**
 * A parsed segment path: which session, which position, end-marked or not.
 */
export interface ParsedAudioMemoPart {
  memo: AudioMemoIdentity
  part: number
  end: boolean
}

/**
 * Parse a recording path into its session identity and segment position.
 * A legacy suffix-free recording is a one-part, already-ended session.
 */
export function audioMemoPartFromPath(path: string): ParsedAudioMemoPart | null {
  const match = MEMO_PATH_RE.exec(path)
  if (match === null) {
    return null
  }
  const [, base, stamp, part, end, extension] = match
  if (base === undefined || stamp === undefined || extension === undefined) {
    return null
  }
  const partNumber = part === undefined ? 1 : Number(part)
  if (partNumber < 1) {
    return null
  }
  const fields = parseFileStamp(stamp)
  if (fields === null) {
    return null
  }
  return {
    memo: buildIdentity(base, fields, extension),
    part: partNumber,
    end: part === undefined ? true : end !== undefined,
  }
}

/**
 * The stored path of one session segment, e.g. `….part-002-end.m4a`.
 */
export function audioMemoPartPath(memo: AudioMemoIdentity, part: number, end: boolean): string {
  const extension = memo.audioPath.slice(memo.audioPath.lastIndexOf('.') + 1)
  return audioMemoPath(`${memo.base}.part-${pad(part, 3)}${end ? '-end' : ''}.${extension}`)
}
