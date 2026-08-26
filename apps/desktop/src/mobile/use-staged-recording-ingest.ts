import { useEffect, useRef } from 'react'
import { listStaged } from '@reflect/core'
import { isNativeShell } from '@/lib/platform'
import {
  claimStagedPath,
  isStagedPathClaimed,
  type NativeRecordingPart,
} from '@/mobile/use-native-audio-recorder'

/**
 * The orphan scan (audio-memos wave 1): staged segments no live flow owns —
 * from a crash, a webview reload, or a kill while backgrounded — are handed
 * to the capture pipeline on mount and on every foreground, oldest session
 * first. Finished segments of the session recording *right now* are picked
 * up too: they are complete files (`list_staged` excludes the one still being
 * written), and landing them early is the point. The caller's `enqueuePart`
 * owns deleting the staged file once the graph write lands; ingest is
 * idempotent by session and position, so a file whose delete failed
 * re-resolves to the same segment on the next scan instead of duplicating.
 */

/** Mount the launch/foreground orphan scan. */
export function useStagedRecordingIngest(
  enqueuePart: (part: NativeRecordingPart) => void,
): void {
  const scanningRef = useRef(false)
  useEffect(() => {
    if (!isNativeShell()) {
      return
    }
    let disposed = false
    const scan = async (): Promise<void> => {
      if (scanningRef.current) {
        return
      }
      scanningRef.current = true
      try {
        const files = await listStaged()
        for (const file of files) {
          if (disposed) {
            return
          }
          if (isStagedPathClaimed(file.path)) {
            continue
          }
          claimStagedPath(file.path)
          enqueuePart({
            stagedPath: file.path,
            recordedAt: new Date(file.sessionStartedMs),
            part: file.part,
            end: file.end,
          })
        }
      } catch (cause) {
        console.error('audio memo orphan scan failed:', cause)
      } finally {
        scanningRef.current = false
      }
    }
    void scan()
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void scan()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enqueuePart])
}
