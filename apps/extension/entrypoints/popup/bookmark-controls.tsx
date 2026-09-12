import { useEffect, useState, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import { readBookmarkSettings, writeBookmarkSettings } from '@/lib/bookmark-settings'

const X_ACCESS = { permissions: ['webRequest' as const], origins: ['https://x.com/*'] }

/** Opt out of recording new X bookmarks into the daily note. */
export function BookmarkControls(): ReactElement {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [granted, setGranted] = useState(true)
  useEffect(() => {
    let active = true
    void Promise.all([readBookmarkSettings(), browser.permissions.contains(X_ACCESS)]).then(
      ([settings, access]) => {
        if (active) {
          setEnabled(settings.enabled)
          setGranted(access)
        }
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
    <div className="flex flex-col gap-1 border-t border-border p-3 text-xs text-text-secondary">
      <label className="flex items-center gap-2">
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
      {enabled && !granted ? (
        <p className="text-text-muted">
          Reflect Capture has no access to x.com. Allow it under Site access in chrome://extensions.
        </p>
      ) : null}
    </div>
  )
}
