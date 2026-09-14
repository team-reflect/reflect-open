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
import { LIKE_SETTINGS_KEY, readLikeSettings, writeLikeSettings } from '@/lib/like-settings'
import {
  X_CAPTURE_ERROR_KEY,
  CAPTURE_DELIVERY_KEY,
  readXCaptureError,
  readCaptureDelivery,
  dismissXCaptureError,
} from '@/lib/x-capture-status'
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
  const includePageText = useStoredSetting(INCLUDE_PAGE_TEXT_KEY, readIncludePageTextPreference)
  const bookmarks = useStoredSetting(BOOKMARK_SETTINGS_KEY, readBookmarkSettings)
  const likes = useStoredSetting(LIKE_SETTINGS_KEY, readLikeSettings)
  const captureError = useStoredSetting(X_CAPTURE_ERROR_KEY, readXCaptureError)
  const delivery = useStoredSetting(CAPTURE_DELIVERY_KEY, readCaptureDelivery)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingX, setSavingX] = useState(false)
  const [xAccess, requestXAccess] = useXAccess()
  const [xAccessRefused, setXAccessRefused] = useState(false)

  function onIncludePageTextChange(next: boolean): void {
    void writeIncludePageTextPreference(next).catch((cause: unknown) => {
      console.error('could not save the page text preference:', cause)
    })
  }

  async function saveXSetting(kind: 'bookmark' | 'like', next: boolean): Promise<void> {
    setSavingX(true)
    setSettingsError(null)
    try {
      await (kind === 'like'
        ? writeLikeSettings({ enabled: next })
        : writeBookmarkSettings({ enabled: next }))
    } catch {
      setSettingsError('Could not save the X setting. Please try again.')
    } finally {
      setSavingX(false)
    }
  }

  async function onAllowXAccess(): Promise<void> {
    try {
      setXAccessRefused(!(await requestXAccess()))
    } catch (cause) {
      console.error('x.com access request failed:', cause)
      setXAccessRefused(true)
    }
  }

  const showXAccessNotice =
    (bookmarks?.enabled === true || likes?.enabled === true) && xAccess === false

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
          disabled={bookmarks === null || savingX}
          onCheckedChange={(next) => void saveXSetting('bookmark', next)}
        />
        <SettingsSwitchRow
          legend="Save new X likes to my daily note"
          description="Saves new like actions on x.com in this browser under X likes. Existing likes are not imported. Unliking a post will not remove it from Reflect."
          checked={likes?.enabled ?? false}
          disabled={likes === null || savingX}
          onCheckedChange={(next) => void saveXSetting('like', next)}
        />
        <p className="px-4 py-3 text-xs text-text-muted">
          A like or bookmark request can be saved even if X later rejects it.
        </p>
        {settingsError ? (
          <p role="alert" className="px-4 py-3 text-xs">
            {settingsError}
          </p>
        ) : null}
        {captureError ? (
          <div role="alert" className="px-4 py-3 text-xs">
            <p>{captureError}</p>
            <button
              type="button"
              onClick={() =>
                void dismissXCaptureError().catch(() => {
                  setSettingsError('Could not dismiss the capture error. Please try again.')
                })
              }
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {delivery && delivery.held > 0 ? (
          <p role="status" className="px-4 py-3 text-xs">
            {delivery.holdReason === 'unsupported-version'
              ? 'Update Reflect to save X posts. Your captures are still queued.'
              : 'Captures are waiting for Reflect. Open Reflect and check your graph; accepted captures remain queued.'}
          </p>
        ) : null}
        {showXAccessNotice ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3 text-xs text-text-muted">
            <span>
              Reflect Capture can’t see x.com right now, so enabled X captures are not being saved.
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
