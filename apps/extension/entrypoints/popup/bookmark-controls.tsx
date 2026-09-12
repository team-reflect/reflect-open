import { useEffect, useState, type ReactElement } from 'react'
import { readBookmarkSettings, writeBookmarkSettings } from '@/lib/bookmark-settings'

/** Opt out of recording new X bookmarks into the daily note. */
export function BookmarkControls(): ReactElement {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let active = true
    void readBookmarkSettings().then(
      (settings) => {
        if (active) setEnabled(settings.enabled)
      },
      (cause: unknown) => {
        console.error('could not read bookmark settings:', cause)
      },
    )
    return () => {
      active = false
    }
  }, [])

  return (
    <label className="flex items-center gap-2 border-t border-border p-3 text-xs text-text-secondary">
      <input
        type="checkbox"
        checked={enabled === true}
        disabled={enabled === null}
        onChange={(event) => {
          const next = event.target.checked
          setEnabled(next)
          void writeBookmarkSettings({ enabled: next }).catch((cause: unknown) => {
            console.error('could not save bookmark settings:', cause)
          })
        }}
        className="size-3.5 rounded border-border text-accent focus:ring-focus-ring"
      />
      Save new X bookmarks to my daily note
    </label>
  )
}
