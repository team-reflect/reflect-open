import { useEffect, useState, type ReactElement } from 'react'
import { browser } from 'wxt/browser'
import {
  BOOKMARK_SETTINGS_KEY,
  readBookmarkSettings,
  writeBookmarkSettings,
  X_BOOKMARK_ACCESS,
} from '@/lib/bookmark-settings'
import {
  INCLUDE_PAGE_TEXT_KEY,
  readIncludePageTextPreference,
  writeIncludePageTextPreference,
} from '@/lib/popup-preferences'
import { SettingsSection, SettingsSwitchRow } from './settings-rows'
import { useStoredSetting } from './use-stored-setting'

/**
 * The extension's settings page: every stored choice that is not part of a
 * single capture. Chrome opens it in a dialog over chrome://extensions.
 */

const SITE_ACCESS_FALLBACK = 'Allow it under Site access in chrome://extensions.'

function useXAccess(): [granted: boolean | null, request: () => Promise<boolean>] {
  const [granted, setGranted] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void browser.permissions.contains(X_BOOKMARK_ACCESS).then((has) => {
        if (!cancelled) setGranted(has)
      })
    }
    browser.permissions.onAdded.addListener(refresh)
    browser.permissions.onRemoved.addListener(refresh)
    refresh()
    return () => {
      cancelled = true
      browser.permissions.onAdded.removeListener(refresh)
      browser.permissions.onRemoved.removeListener(refresh)
    }
  }, [])

  const request = async (): Promise<boolean> => {
    const has = await browser.permissions.request(X_BOOKMARK_ACCESS)
    setGranted(has)
    return has
  }
  return [granted, request]
}

export function OptionsPage(): ReactElement {
  const [includePageText, setIncludePageText] = useStoredSetting(
    INCLUDE_PAGE_TEXT_KEY,
    readIncludePageTextPreference,
  )
  const [bookmarks, setBookmarks] = useStoredSetting(BOOKMARK_SETTINGS_KEY, readBookmarkSettings)
  const [xAccess, requestXAccess] = useXAccess()
  const [xAccessRefused, setXAccessRefused] = useState(false)

  function onIncludePageTextChange(next: boolean): void {
    setIncludePageText(next)
    void writeIncludePageTextPreference(next).catch((cause: unknown) => {
      console.error('could not save the page text preference:', cause)
    })
  }

  function onBookmarksChange(next: boolean): void {
    setBookmarks({ enabled: next })
    void writeBookmarkSettings({ enabled: next }).catch((cause: unknown) => {
      console.error('could not save bookmark settings:', cause)
    })
  }

  async function onAllowXAccess(): Promise<void> {
    try {
      setXAccessRefused(!(await requestXAccess()))
    } catch (cause) {
      console.error('x.com access request failed:', cause)
      setXAccessRefused(true)
    }
  }

  const showXAccessNotice = bookmarks?.enabled === true && xAccess === false

  return (
    <main className="mx-auto max-w-md p-6">
      <SettingsSection title="Page capture">
        <SettingsSwitchRow
          legend="Include page text"
          description="Adds the page’s readable text to every capture, including ⌘⇧K saves. The popup’s “Capture page text” box starts from this and updates it."
          checked={includePageText ?? false}
          disabled={includePageText === null}
          onCheckedChange={onIncludePageTextChange}
        />
      </SettingsSection>
      <SettingsSection title="X">
        <SettingsSwitchRow
          legend="Save new X bookmarks to my daily note"
          description="Bookmarking a post on x.com adds its link under “X bookmarks” in that day’s note."
          checked={bookmarks?.enabled ?? true}
          disabled={bookmarks === null}
          onCheckedChange={onBookmarksChange}
        />
        {showXAccessNotice ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3 text-xs text-text-muted">
            <span>
              Reflect Capture can’t see x.com right now, so bookmarks aren’t being saved.
              {xAccessRefused ? ` ${SITE_ACCESS_FALLBACK}` : null}
            </span>
            <button
              type="button"
              onClick={() => void onAllowXAccess()}
              className="shrink-0 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-text hover:bg-surface-hover"
            >
              Allow access to x.com
            </button>
          </div>
        ) : null}
      </SettingsSection>
    </main>
  )
}
