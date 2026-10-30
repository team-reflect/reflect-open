import { formatIsoDate } from '@reflect/utils'
import { formatFileStamp, parseFileStamp } from '../lib/file-stamp.ts'
import { assetPath, notePath } from '../graph/paths.ts'

const INBOX_PREFIX = '.reflect/inbox/'

/** Is this watcher path a spooled capture envelope? */
export function isCaptureSpoolPath(path: string): boolean {
  return path.startsWith(INBOX_PREFIX) && path.endsWith('.json')
}

/** Strip the inbox prefix off a spool listing path. */
export function captureSpoolName(path: string): string {
  return path.startsWith(INBOX_PREFIX) ? path.slice(INBOX_PREFIX.length) : path
}

/** Everything derivable from a capture's timestamped base name. */
export interface CaptureIdentity {
  /** `capture-2026-06-12-153022-845` — note filename, alias, asset stem. */
  base: string
  /** Local ISO day of the capture — the daily note that links it. */
  date: string
  /** Graph-relative path of the capture note, `notes/<base>.md`. */
  notePath: string
  /** Graph-relative path of the promoted screenshot, `assets/<base>.jpg`. */
  assetPath: string
}

const CAPTURE_PATH_RE = /^notes\/(capture-(\d{4}-\d{2}-\d{2}-\d{6}-\d{3})-[0-9a-f]{4})\.md$/

function buildIdentity(base: string, date: string): CaptureIdentity {
  return {
    base,
    date,
    notePath: notePath(base),
    assetPath: assetPath(`${base}.jpg`),
  }
}

/**
 * The identity a capture stores under — local-time components of `capturedAt`
 * plus a slice of the envelope UUID.
 */
export function captureIdentity(capturedAt: Date, envelopeId: string): CaptureIdentity {
  const suffix = envelopeId.slice(0, 4).toLowerCase()
  const base = `capture-${formatFileStamp(capturedAt)}-${suffix}`
  return buildIdentity(base, formatIsoDate(capturedAt))
}

/**
 * Recover a capture's identity from its note path, or `null` for anything
 * that isn't a well-formed capture note.
 */
export function captureFromPath(path: string): CaptureIdentity | null {
  const match = CAPTURE_PATH_RE.exec(path)
  if (match === null) {
    return null
  }
  const [, base, stamp] = match
  const parsed = stamp === undefined ? null : parseFileStamp(stamp)
  if (base === undefined || parsed === null) {
    return null
  }
  return buildIdentity(base, parsed.date)
}
