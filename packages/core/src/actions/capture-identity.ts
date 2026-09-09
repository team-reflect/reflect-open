import { assetPath, dailyPath, notePath } from '../graph/paths'

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

const CAPTURE_PATH_RE =
  /^notes\/(capture-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})-\d{3}-[0-9a-f]{4})\.md$/

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * The **local** calendar day of a capture — the daily note it lands on, per
 * the audio-memo convention.
 */
export function captureLocalDate(capturedAt: Date): string {
  return `${capturedAt.getFullYear()}-${pad(capturedAt.getMonth() + 1, 2)}-${pad(capturedAt.getDate(), 2)}`
}

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
  const date = captureLocalDate(capturedAt)
  const stamp = `${pad(capturedAt.getHours(), 2)}${pad(capturedAt.getMinutes(), 2)}${pad(capturedAt.getSeconds(), 2)}`
  const suffix = envelopeId.slice(0, 4).toLowerCase()
  const base = `capture-${date}-${stamp}-${pad(capturedAt.getMilliseconds(), 3)}-${suffix}`
  return buildIdentity(base, date)
}

/** Where a post capture's `n`th media lands: `assets/<capture base>-<n>.jpg` (Plan 25). */
export function postMediaAssetPath(identity: CaptureIdentity, index: number): string {
  return assetPath(`${identity.base}-${index + 1}.jpg`)
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
  const [, base, date, hours, minutes, seconds] = match
  if (
    base === undefined ||
    date === undefined ||
    hours === undefined ||
    minutes === undefined ||
    seconds === undefined
  ) {
    return null
  }
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    return null
  }
  try {
    dailyPath(date)
  } catch {
    return null
  }
  return buildIdentity(base, date)
}
