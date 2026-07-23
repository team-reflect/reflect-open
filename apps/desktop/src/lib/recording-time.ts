/**
 * Elapsed-time display shared by the recording surfaces (the desktop
 * popover and the mobile drawer). Hours appear only once reached — `3:05`,
 * then `1:02:09` — so a quick memo keeps the compact form while a
 * meeting-length one never shows an odd `183:42`.
 */
export function formatRecordingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`
}
