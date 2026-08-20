import { useEffect } from 'react'
import { getAppStoreEnvironment } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { markBootTiming, measureBootTiming } from '@/mobile/boot-timing'
import type { PaywallGate } from '@/mobile/use-should-show-paywall'
import { useGraph, type GraphStatus } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

// One probe per process, whatever React does with the effect: StrictMode
// double-invokes effects in dev, and a second call would answer from
// StoreKit's warm cache and understate the cold-start cost this measures.
let probedEnvironment = false

/**
 * Temporary: time the boot path the iOS paywall gate sits on. See
 * `boot-timing.ts` for what the numbers are for, and delete both together.
 *
 * The install-channel probe is fired here because nothing else calls it at
 * boot yet (Settings only asks for it behind the debug unlock), and its
 * cold-start cost is the main unknown: a production-only paywall would put it
 * in front of the first screen.
 */
export function useBootTiming(gate: PaywallGate, graphStatus: GraphStatus): void {
  const { platform } = useGraph()
  const bridgeReady = useBridgeReady()
  const { whenSettingsLoaded } = useSettings()

  // Each transition, not each render: the gate answers on every render of
  // `MobileApp` and only the changes are interesting.
  useEffect(() => {
    markBootTiming(`gate: ${gate}`)
  }, [gate])

  useEffect(() => {
    markBootTiming(`graph: ${graphStatus}`)
  }, [graphStatus])

  useEffect(() => {
    void measureBootTiming('settings load', whenSettingsLoaded).then((outcome) => {
      markBootTiming(`settings load outcome: ${outcome}`)
    })
  }, [whenSettingsLoaded])

  useEffect(() => {
    if (platform !== 'ios' || !bridgeReady || probedEnvironment) {
      return
    }
    probedEnvironment = true
    void measureBootTiming('app-store environment probe', getAppStoreEnvironment)
      .then((environment) => {
        markBootTiming(`app-store environment: ${environment}`)
      })
      // Already recorded as a failure by `measureBootTiming`; this only keeps
      // the rejection from surfacing as an unhandled promise.
      .catch(() => {})
  }, [bridgeReady, platform])
}
