import type { Settings, SettingsLoadOutcome, SettingsService, Store } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'
import { useStore, useSelector } from '@/lib/use-store.ts'
import { useCallback } from 'react'

interface SettingsValue {
  settings: Settings
  /**
   * Merge `patch` into the settings: applied immediately, persisted async.
   */
  updateSettings: (patch: Partial<Settings>) => void
  /**
   * Compute a patch from the latest settings; pre-load calls replay after hydration.
   */
  updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) => void
  /**
   * Resolve after the initial disk load; `'failed'` means session-only updates.
   */
  whenSettingsLoaded: () => Promise<SettingsLoadOutcome>
}

/**
 * Access the current settings and the updater. Use within an `CoreServicesProvider`.
 */
export function useSettings(): SettingsValue {
  const service = useCoreServices().settings
  const settings = useServiceState(service, service.get)
  return {
    settings,
    updateSettings: service.update,
    updateSettingsWith: service.updateWith,
    whenSettingsLoaded: service.whenLoaded,
  }
}

export function useSettingsService(): SettingsService {
  return useCoreServices().settings satisfies Store<Settings>
}

export function useSettingsStore(): Settings {
  const store = useSettingsService()
  return useStore(store)
}

function useSettingsSelector<T>(selector: (settings: Settings) => T): T {
  const store = useSettingsService()
  return useSelector(store, selector)
}

export function useSettingsField<K extends keyof Settings>(key: K): Settings[K] {
  const selector = useCallback(
    (settings: Settings) => {
      return settings[key]
    },
    [key],
  )
  return useSettingsSelector(selector)
}
