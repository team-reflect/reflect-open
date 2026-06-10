import { getCurrentWindow } from '@tauri-apps/api/window'
import { confirmQuit, hasBridge, subscribeQuitRequested } from '@reflect/core'
import { flushOpenDocuments } from '@/editor/open-documents'

/**
 * Quit-time persistence: the webview never dies with dirty note buffers still
 * inside their save debounce. Three exits, three hooks:
 *
 * - **Window close** (red button, ⌘W): registering a JS `onCloseRequested`
 *   listener defers the close until the handler returns, so the flush is
 *   awaited before the window is destroyed.
 * - **App quit** (⌘Q): never reaches close-requested — the Rust shell defers
 *   `ExitRequested` once and emits `app:quit-requested`; we flush, then
 *   `confirmQuit()` exits for real (even if a flush failed: its error is
 *   already surfaced per-note, and refusing to quit would trap the user).
 * - **Webview unload** (dev reloads): `beforeunload` can't await, but writes
 *   dispatched before teardown still reach the Rust process — a belt.
 */
export function installQuitFlush(): () => void {
  // No bridge → no native shell (plain-browser dev): nothing can quit-flush.
  // getCurrentWindow below is safe to reach only inside a Tauri webview.
  if (!hasBridge()) {
    return () => {}
  }

  let disposed = false
  const disposers: Array<() => void> = []
  const track = (dispose: () => void): void => {
    // A subscription can resolve after teardown (StrictMode's probe mount).
    if (disposed) {
      dispose()
    } else {
      disposers.push(dispose)
    }
  }

  void getCurrentWindow()
    .onCloseRequested(async () => {
      await flushOpenDocuments()
    })
    .then(track)

  void subscribeQuitRequested(() => {
    void flushOpenDocuments().finally(() => {
      void confirmQuit()
    })
  }).then(track)

  const onBeforeUnload = (): void => {
    void flushOpenDocuments()
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  track(() => window.removeEventListener('beforeunload', onBeforeUnload))

  return () => {
    disposed = true
    for (const dispose of disposers) {
      dispose()
    }
    disposers.length = 0
  }
}
