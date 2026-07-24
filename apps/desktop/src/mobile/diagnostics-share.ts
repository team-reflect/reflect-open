import { useCallback, useEffect, useState } from 'react'
import {
  errorMessage,
  getDiagnosticsSnapshot,
  type DiagnosticsSnapshot,
} from '@reflect/core'

export interface PreparedDiagnosticsShare {
  readonly filename: string
  readonly text: string
  readonly file: File | null
}

/** Builds the share payload ahead of the user's tap so WebKit activation survives. */
export function prepareDiagnosticsShare(
  snapshot: DiagnosticsSnapshot,
): PreparedDiagnosticsShare {
  const suffix = snapshot.build ?? String(snapshot.generatedAtMs)
  const filename = `reflect-diagnostics-${suffix}.json`
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  const file =
    typeof File === 'undefined'
      ? null
      : new File([text], filename, { type: 'application/json' })
  return { filename, text, file }
}

/**
 * Opens the OS share sheet synchronously. Do not make this function async or
 * put an awaited IPC call before `navigator.share`: iOS consumes the tap's
 * transient activation as soon as the task yields.
 */
export function sharePreparedDiagnostics(
  prepared: PreparedDiagnosticsShare,
  shareNavigator: Pick<Navigator, 'share' | 'canShare'> = navigator,
): Promise<void> {
  if (typeof shareNavigator.share !== 'function') {
    return Promise.reject(new Error('Sharing is unavailable on this device'))
  }
  if (prepared.file !== null) {
    try {
      const files = [prepared.file]
      if (shareNavigator.canShare?.({ files }) === true) {
        return shareNavigator.share({
          title: 'Reflect diagnostics',
          files,
        })
      }
    } catch {
      // Fall through to the text form when file-sharing capability detection
      // itself is unavailable or rejects the payload.
    }
  }
  return shareNavigator.share({
    title: 'Reflect diagnostics',
    text: prepared.text,
  })
}

interface DiagnosticsShareState {
  readonly ready: boolean
  readonly loading: boolean
  readonly sharing: boolean
  readonly error: string | null
  readonly prepare: () => void
  readonly share: () => void
}

/** Prepares and shares the bounded native journal without losing tap activation. */
export function useDiagnosticsShare(enabled = true): DiagnosticsShareState {
  const [prepared, setPrepared] = useState<PreparedDiagnosticsShare | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [sharing, setSharing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const prepare = useCallback((): void => {
    if (!enabled) {
      return
    }
    setLoading(true)
    setError(null)
    void getDiagnosticsSnapshot().then(
      (snapshot) => {
        setPrepared(prepareDiagnosticsShare(snapshot))
        setLoading(false)
      },
      (cause: unknown) => {
        setPrepared(null)
        setError(errorMessage(cause))
        setLoading(false)
      },
    )
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void getDiagnosticsSnapshot().then(
      (snapshot) => {
        if (!cancelled) {
          setPrepared(prepareDiagnosticsShare(snapshot))
          setLoading(false)
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause))
          setLoading(false)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled])

  const share = useCallback((): void => {
    if (prepared === null) {
      return
    }
    let pending: Promise<void>
    try {
      pending = sharePreparedDiagnostics(prepared)
    } catch (cause) {
      setError(errorMessage(cause))
      return
    }
    setSharing(true)
    setError(null)
    void pending.then(
      () => setSharing(false),
      (cause: unknown) => {
        setSharing(false)
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(errorMessage(cause))
        }
      },
    )
  }, [prepared])

  return {
    ready: prepared !== null,
    loading,
    sharing,
    error,
    prepare,
    share,
  }
}
