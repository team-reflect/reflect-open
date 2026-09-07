import { useEffect, useState, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { flushResultSchema } from '@/lib/messages'
import { xSettingsResultSchema } from '@/lib/x-capture'
import { X_DEFAULT_SETTINGS, X_ORIGINS, X_SETTINGS_KEY, type XSettings } from '@/lib/x-config'

export function CaptureOptions(): ReactElement {
  const [settings, setSettings] = useState(X_DEFAULT_SETTINGS)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function refresh(): Promise<void> {
      try {
        const response: unknown = await browser.runtime.sendMessage({ type: 'x:status' })
        setSettings(xSettingsResultSchema.parse(response).settings)
      } catch (cause) {
        setError(String(cause))
      } finally {
        setBusy(false)
      }
    }
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && X_SETTINGS_KEY in changes) void refresh()
    }
    browser.storage.onChanged.addListener(listener)
    void refresh()
    return () => browser.storage.onChanged.removeListener(listener)
  }, [])

  async function save(next: XSettings): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      if (next.bookmarks && !(await browser.permissions.request({ origins: X_ORIGINS }))) {
        setError('X site access was not granted.')
        return
      }
      const response: unknown = await browser.runtime.sendMessage({
        type: 'x:configure',
        settings: next,
      })
      const result = xSettingsResultSchema.parse(response)
      setSettings(result.settings)
      setError(result.error ?? null)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function retry(): Promise<void> {
    setBusy(true)
    try {
      const result = flushResultSchema.parse(await browser.runtime.sendMessage({ type: 'flush' }))
      setError(
        result.holdReason === 'upgrade-required'
          ? 'Upgrade and launch Reflect, then retry. Your X captures remain queued.'
          : result.held > 0
            ? `${result.held} captures are waiting for Reflect. Launch Reflect and select a graph.`
            : null,
      )
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 p-6 text-sm">
      <h1 className="text-xl font-semibold">X capture</h1>
      <p className="text-text-secondary">
        Save a post with the toolbar button or keyboard shortcut. Each manual save creates a
        separate snapshot.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.bookmarks}
          disabled={busy}
          onChange={(event) =>
            void save({
              bookmarks: event.target.checked,
              likes: event.target.checked && settings.likes,
            })
          }
        />
        Automatically capture bookmarks (experimental)
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={settings.likes}
          disabled={busy || !settings.bookmarks}
          onChange={(event) => void save({ ...settings, likes: event.target.checked })}
        />
        Also capture likes
      </label>
      <p className="text-xs text-text-muted">
        Automatic capture saves a post once per day. It observes your actions on open X pages; it
        does not import earlier bookmarks. X page changes may interrupt capture.
      </p>
      <p className="text-xs text-text-muted">
        The local queue holds 50 captures. At capacity, the oldest capture is removed. Launch
        Reflect regularly to finish saving.
      </p>
      <button
        type="button"
        disabled={busy}
        onClick={() => void retry()}
        className="self-start rounded-md bg-accent px-3 py-1.5 font-medium text-text-on-brand disabled:opacity-60"
      >
        Retry pending captures
      </button>
      {error ? (
        <p role="status" className="text-text-secondary">
          {error}
        </p>
      ) : null}
    </main>
  )
}
