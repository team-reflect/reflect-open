import { formatDate, formatIsoDate, parseDate } from '@reflect/utils'

/**
 * The local timestamp in capture and audio-memo file names, such as
 * `2026-06-12-153022-845`.
 */
const FILE_STAMP_FORMAT = 'yyyy-MM-dd-HHmmss-SSS'

/** The file-name stamp of `date`, in local time. */
export function formatFileStamp(date: Date): string {
  return formatDate(date, FILE_STAMP_FORMAT)
}

/**
 * The local ISO date and `HH:mm:ss` time of a {@link formatFileStamp} stamp, or
 * `null` when the stamp names no real moment.
 */
export function parseFileStamp(stamp: string): { date: string; time: string } | null {
  const date = parseDate(stamp, FILE_STAMP_FORMAT)
  return date === null ? null : { date: formatIsoDate(date), time: formatDate(date, 'HH:mm:ss') }
}
