import { getCurrentWindow } from '@tauri-apps/api/window'
import { hasBridge } from '@reflect/core'

/**
 * Which window this webview is: the main window (the config-declared `main`
 * label — also what plain-browser dev and mobile report) or a secondary
 * `note-*` window opened by a modifier click or command.
 *
 * Secondary windows *adopt* the main window's graph session and run none of
 * the app-wide singletons — the index writer, sync/backup, the capture
 * drain, transcription and embedding reconcilers, update checks, and the OS
 * deep-link intake all belong to the main window. Every such gate funnels
 * through this predicate so the ownership rule lives in one place.
 */
export function isMainWindow(): boolean {
  if (!hasBridge()) {
    return true // plain-browser dev: one window, no native shell
  }
  try {
    return getCurrentWindow().label === 'main'
  } catch (cause) {
    // A bridge without Tauri window metadata: the jsdom test harness and the
    // ?platform=ios browser harness. Both are single-window — main. In a real
    // Tauri webview the internals are injected before any script runs, so
    // this can't fire there; warn loudly in case that assumption ever breaks
    // (a misclassified note window would boot the main-window singletons).
    console.warn('window label unavailable; assuming the main window:', cause)
    return true
  }
}

/**
 * Guard for graph-session mutations only the main window may run — opening,
 * switching, or deleting a graph re-roots the shared Rust `GraphState` under
 * every window at once. True in the main window; elsewhere warns and returns
 * false so call sites bail.
 */
export function requireMainWindow(action: string): boolean {
  if (isMainWindow()) {
    return true
  }
  console.warn(`${action} is only available from the main window`)
  return false
}
