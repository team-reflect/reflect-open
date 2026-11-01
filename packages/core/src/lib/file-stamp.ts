import { formatDate, parseDate } from '@reflect/utils'

/**
 * The local timestamp in capture and audio-memo file names, such as
 * `2026-06-12-153022-845`.
 */
const FILE_STAMP_FORMAT = 'yyyy-MM-dd-HHmmss-SSS'

/** The file-name stamp of `date`, in local time. */
export function formatFileStamp(date: Date): string {
  return formatDate(date, FILE_STAMP_FORMAT)
}

/** The ISO date and `HH:mm:ss` time written in a {@link formatFileStamp} stamp. */
export interface FileStamp {
  date: string
  time: string
}

/**
 * The fields of a {@link formatFileStamp} stamp, or `null` when a field is out
 * of range. The fields are read from the stamp as written: a local `Date` would
 * shift a time that falls in this device's DST gap.
 */
export function parseFileStamp(stamp: string): FileStamp | null {
  if (parseDate(stamp, FILE_STAMP_FORMAT) === null) {
    return null
  }
  const time = `${stamp.slice(11, 13)}:${stamp.slice(13, 15)}:${stamp.slice(15, 17)}`
  return { date: stamp.slice(0, 10), time }
}
