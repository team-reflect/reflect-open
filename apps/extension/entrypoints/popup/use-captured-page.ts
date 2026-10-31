import { useEffect, useState } from 'react'
import {
  snapshotActiveTab,
  type CapturedPageState as SnapshotCapturedPageState,
} from '@/lib/snapshot-active-tab'

/**
 * Snapshot the active tab the moment the popup opens. The action invocation
 * granted `activeTab`, so URL, title, screenshot, and selection are readable
 * when Chrome allows them.
 */

export type CapturedPageState = { status: 'loading' } | SnapshotCapturedPageState

export function useCapturedPage(): CapturedPageState {
  const [state, setState] = useState<CapturedPageState>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    snapshotActiveTab().then(
      (snapshot) => {
        if (!cancelled) setState(snapshot)
      },
      () => {
        if (!cancelled) setState({ status: 'uncapturable' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
