/** Human-readable file size: whole MB at megabyte scale, whole KB below it. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}
