import { getCurrentWindow } from '@tauri-apps/api/window'
import { isNativeShell } from '@/lib/platform'

/**
 * Set this webview's OS window title. Best-effort and shell-only: browser
 * dev has no window frame, and a failed set must never surface — the title
 * is chrome, not state. Note windows use it so the Window menu and
 * ⌘-backtick cycling can tell N note windows apart.
 */
export function setWindowTitle(title: string): void {
  if (!isNativeShell()) {
    return
  }
  try {
    void getCurrentWindow().setTitle(title)
  } catch {
    // No Tauri window metadata (test harnesses) — nothing to title.
  }
}
