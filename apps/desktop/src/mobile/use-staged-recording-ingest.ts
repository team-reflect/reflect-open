import { useEffect, useRef } from 'react'
import { listStaged } from '@reflect/core'
import { isNativeShell } from '@/lib/platform'
import {
  claimStagedPath,
  isStagedPathClaimed,
  readStagedRecording,
  releaseStagedPath,
} from '@/mobile/use-native-audio-recorder'

/**
 * The orphan scan (audio-memos wave 1): staged recordings no live flow owns —
 * from a crash, a webview reload, or a kill while backgrounded — are read
 * back and handed to the capture pipeline on mount and on every foreground,
 * oldest first (`list_staged` sorts by name = by time). The caller's
 * `enqueueStaged` owns deleting the file once the graph write lands; ingest
 * is idempotent by stop time, so a file whose delete failed re-resolves to
 * the same memo identity on the next scan instead of duplicating.
 */

/** A staged native recording, ready for the capture pipeline. */
export interface StagedRecordingInput {
  blob: Blob
  /** The memo's identity timestamp — the file's stop time for re-scans. */
  recordedAt: Date
  /** The staging-directory file the capture owns until it lands. */
  stagedPath: string
}

/** Mount the launch/foreground orphan scan. */
export function useStagedRecordingIngest(
  enqueueStaged: (input: StagedRecordingInput) => void,
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
          try {
            const blob = await readStagedRecording(file.path)
            enqueueStaged({
              blob,
              recordedAt: new Date(file.modifiedMs),
              stagedPath: file.path,
            })
          } catch (cause) {
            releaseStagedPath(file.path)
            console.error('ingesting a staged recording failed:', cause)
          }
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
  }, [enqueueStaged])
}
