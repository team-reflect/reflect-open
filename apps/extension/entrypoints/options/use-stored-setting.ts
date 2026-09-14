import { useCallback, useEffect, useState } from 'react'
import { browser } from 'wxt/browser'

/**
 * A `chrome.storage.local` value behind one settings control: read once,
 * re-read whenever `key` changes in storage (another extension page may
 * write it while this one is open), `null` until the first read lands.
 * `read` must be a stable function reference (a module export).
 */
export function useStoredSetting<T>(
  key: string,
  read: () => Promise<T>,
): [value: T | null, setValue: (next: T) => void] {
  const [value, setValue] = useState<T | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void read().then(
        (next) => {
          if (!cancelled) setValue(next)
        },
        (cause: unknown) => {
          console.error(`could not read ${key}:`, cause)
        },
      )
    }
    const onChanged = (changes: Record<string, unknown>, area: string): void => {
      if (area === 'local' && key in changes) refresh()
    }
    browser.storage.onChanged.addListener(onChanged)
    refresh()
    return () => {
      cancelled = true
      browser.storage.onChanged.removeListener(onChanged)
    }
  }, [key, read])

  return [value, useCallback((next: T) => setValue(next), [])]
}
