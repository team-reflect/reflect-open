import { useCallback, useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import {
  readXCapturePreferences,
  writeXCapturePreferences,
  X_BOOKMARKS_KEY,
  X_LIKES_KEY,
  type XCapturePreferences,
} from './preferences'
import { disableXCapture, enableXCapture } from './registration'

export interface XCaptureState {
  /** `null` until the stored switches have been read. */
  preferences: XCapturePreferences | null
  /** A switch is being applied (a permission prompt may be open). */
  busy: boolean
  /** Switch the feature on: asks for the origins; resolves with the result. */
  enable: () => Promise<boolean>
  disable: () => Promise<void>
  setLikes: (likes: boolean) => Promise<void>
}

/**
 * The X capture switches for an extension page (options, popup), kept in
 * step with storage — another page or the background (a revoked
 * permission) may flip them while this one is open.
 */
export function useXCapture(): XCaptureState {
  const [preferences, setPreferences] = useState<XCapturePreferences | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void readXCapturePreferences().then((stored) => {
      if (!cancelled) {
        setPreferences(stored)
      }
    })
    const onChanged = (changes: Record<string, unknown>, area: string): void => {
      if (area === 'local' && (X_BOOKMARKS_KEY in changes || X_LIKES_KEY in changes)) {
        void readXCapturePreferences().then((stored) => {
          if (!cancelled) {
            setPreferences(stored)
          }
        })
      }
    }
    browser.storage.onChanged.addListener(onChanged)
    return () => {
      cancelled = true
      browser.storage.onChanged.removeListener(onChanged)
    }
  }, [])

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    setBusy(true)
    try {
      return await action()
    } finally {
      setPreferences(await readXCapturePreferences())
      setBusy(false)
    }
  }, [])

  return {
    preferences,
    busy,
    enable: useCallback(() => run(enableXCapture), [run]),
    disable: useCallback(() => run(disableXCapture), [run]),
    setLikes: useCallback(
      (likes: boolean) => run(() => writeXCapturePreferences({ likes })),
      [run],
    ),
  }
}
