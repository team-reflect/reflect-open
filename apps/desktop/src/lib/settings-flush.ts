/**
 * Quit-time flush hook for settings. The persist queue lives inside the
 * settings provider, but quit flushing is installed at module level (see
 * `installQuitFlush`), so the provider registers its flusher in this slot —
 * the same session-owned shape as the open-documents service.
 */

type SettingsFlush = () => Promise<void>

let flusher: SettingsFlush | null = null

/** Register (or clear, with `null`) the mounted provider's flusher. */
export function setSettingsFlusher(flush: SettingsFlush | null): void {
  flusher = flush
}

/**
 * Persist any unconfirmed settings and drain the write queue. Resolves (never
 * rejects) once pending writes have settled; a no-op when no provider is
 * mounted or nothing changed.
 */
export function flushSettings(): Promise<void> {
  return flusher?.() ?? Promise.resolve()
}
