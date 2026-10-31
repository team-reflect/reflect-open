import type { ReactElement } from 'react'
import { IndexProgressPill } from '@/mobile/index-progress-pill.tsx'
import { MobileOperationsPills } from '@/mobile/operations-pill.tsx'
import { SyncStatusPill } from '@/mobile/sync-status-pill.tsx'
import { useKeyboardVisible } from '@/mobile/use-keyboard.ts'

/**
 * The one viewport-anchored slot for mobile status pills, stacked above the
 * tab bar: operation failures ({@link MobileOperationsPills}) over the sync
 * pill. `position: fixed` elements are viewport-anchored — the shell root's
 * keyboard yield doesn't apply — so the layer hides while the keyboard is up
 * and places itself via the height the tab bar publishes (the safe-area
 * fallback covers surfaces without one). The container ignores touches;
 * individual pills opt back in.
 */
export function MobileStatusLayer(): ReactElement | null {
  const keyboardVisible = useKeyboardVisible()

  if (keyboardVisible) {
    return null
  }

  return (
    <div className="pointer-events-none fixed inset-x-safe bottom-above-tab-bar-offset-3 z-50 flex flex-col items-center gap-2">
      <MobileOperationsPills />
      <IndexProgressPill />
      <SyncStatusPill />
    </div>
  )
}
