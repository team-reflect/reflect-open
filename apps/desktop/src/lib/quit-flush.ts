import { getCurrentWindow } from '@tauri-apps/api/window'
import { ask } from '@tauri-apps/plugin-dialog'
import { cancelQuit, confirmQuit, subscribeQuitRequested } from '@reflect/core'
import { flushOpenDocuments } from '@/editor/open-documents.ts'
import { flushBackup } from '@/lib/backup-flush.ts'
import { isMacosDesktop, isNativeShell } from '@/lib/platform.ts'
import { flushSettings } from '@/lib/settings-flush.ts'
import { trackSubscriptions } from '@/lib/subscriptions.ts'
import { isMainWindow } from '@/lib/windows/window-role.ts'

/**
 * Quit-time persistence: the webview never dies with dirty note buffers still
 * inside their save debounce — or with settings writes still in their queue.
 * Three exits, three hooks:
 *
 * - **Window close** (red button, ⌘W): the close is prevented up front and
 *   the flush awaited; then the macOS main window hides (preserving normal
 *   last-window close behavior without terminating the app) and any other
 *   window is destroyed. Edits that could not be saved or archived stop
 *   either step until the user agrees to lose them.
 * - **App quit** (⌘Q): never reaches close-requested — the Rust shell defers
 *   `ExitRequested` once and emits `app:quit-requested`; we flush, then
 *   `confirmQuit()` exits for real (even if a flush failed: its error is
 *   already surfaced per-note, and refusing to quit would trap the user).
 *   The one exception is an unsaved buffer that could not be archived: it
 *   exists nowhere but in memory, so the user is asked before it goes.
 * - **Webview unload** (dev reloads): `beforeunload` can't await, but writes
 *   dispatched before teardown still reach the Rust process — a belt.
 *
 * Mobile's exit is backgrounding, not quitting — its leg of the same flush
 * sequence lives in `background-flush.ts` (Plan 19, decision 6).
 */
/** Note buffers and settings land first, then the backup commit captures them. */
async function flushEverything(): Promise<string[]> {
  const [documents] = await Promise.all([flushOpenDocuments(), flushSettings().catch(() => {})])
  await flushBackup()
  return documents
}

/**
 * Edits that could be neither saved (a parked conflict) nor archived (the
 * archive write failed) exist only in memory. Ask before the exit destroys
 * them; declining keeps the window, and the session, alive.
 */
async function mayDiscard(unpreserved: string[]): Promise<boolean> {
  if (unpreserved.length === 0) {
    return true
  }
  return await ask(
    `Unsaved edits in ${unpreserved.join(', ')} could not be saved or archived. Quit anyway and lose them?`,
    {
      title: 'Unsaved edits',
      kind: 'warning',
      okLabel: 'Quit anyway',
      cancelLabel: 'Keep editing',
    },
  )
}

export function installQuitFlush(): () => void {
  // No native shell (browser dev): nothing can quit-flush. getCurrentWindow
  // below is safe to reach only inside a Tauri webview.
  if (!isNativeShell()) {
    return () => {}
  }

  // A subscription can resolve after teardown (StrictMode's probe mount) —
  // the tracker disposes it on the spot.
  const subscriptions = trackSubscriptions()
  const currentWindow = getCurrentWindow()

  // Note buffers land first, then the backup commit captures them (a local
  // git commit only — pushing on the way out could stall the quit).
  void subscriptions.add(
    currentWindow.onCloseRequested(async (event) => {
      // Prevent synchronously: waiting until after the flush lets AppKit
      // destroy the last window (and Tauri then terminates the process), and
      // the user may still decline to lose unpreserved edits.
      event.preventDefault()
      const unpreserved = await flushEverything()
      if (!(await mayDiscard(unpreserved))) {
        return
      }
      if (isMacosDesktop && isMainWindow()) {
        await currentWindow.hide()
      } else {
        await currentWindow.destroy()
      }
    }),
  )

  void subscriptions.add(
    subscribeQuitRequested(() => {
      void flushEverything().then(async (unpreserved) => {
        // The Rust side armed the handshake for every window; declining must
        // disarm it, or new windows stay refused and a later confirmation
        // from another window could still exit.
        void ((await mayDiscard(unpreserved)) ? confirmQuit() : cancelQuit())
      })
    }),
  )

  const onBeforeUnload = (): void => {
    void flushOpenDocuments()
    void flushSettings()
    void flushBackup()
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  subscriptions.track(() => window.removeEventListener('beforeunload', onBeforeUnload))

  return () => {
    subscriptions.disposeAll()
  }
}
