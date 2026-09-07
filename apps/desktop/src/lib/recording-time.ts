/** `m:ss` under an hour, `h:mm:ss` from there — meeting-length sessions. */
export function formatRecordingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const paddedSeconds = String(seconds).padStart(2, '0')
  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`
  }
  return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
}
