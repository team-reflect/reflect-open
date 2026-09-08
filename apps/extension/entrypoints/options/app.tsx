import { useEffect, useState, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { hasXPermission, setXPermission } from '@/lib/x-permissions'

/** The X bookmark opt-in follows the browser's actual host grants. */
export function CaptureOptions(): ReactElement {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    const refresh = (): void => {
      void hasXPermission()
        .then((granted) => {
          if (!disposed) setEnabled(granted)
        })
        .catch(() => {
          if (!disposed) setError('Could not read X permissions. Reopen settings to retry.')
        })
        .finally(() => {
          if (!disposed) setBusy(false)
        })
    }
    browser.permissions.onAdded.addListener(refresh)
    browser.permissions.onRemoved.addListener(refresh)
    refresh()
    return () => {
      disposed = true
      browser.permissions.onAdded.removeListener(refresh)
      browser.permissions.onRemoved.removeListener(refresh)
    }
  }, [])

  async function toggle(checked: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      setEnabled(await setXPermission(checked))
    } catch {
      setError('Could not change X permissions. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-6 text-sm">
      <h1 className="text-lg font-medium">Reflect Capture</h1>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(event) => {
            void toggle(event.target.checked)
          }}
          className="size-4 accent-accent focus:ring-focus-ring"
        />
        Save new X bookmarks to Reflect
      </label>
      <p className="text-text-secondary">
        Upgrade Reflect before enabling. New bookmark actions save a link to your Daily note, even
        if X later rejects the action. Reflect adds available public text; long posts may only
        include a preview. Images and private posts are not downloaded.
      </p>
      <p className="text-text-secondary">
        Each action creates a separate note. Turning this off stops new captures and keeps captures
        already queued. The shared queue holds 50 captures; older entries are dropped when full.
      </p>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </main>
  )
}
