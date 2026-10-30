import type { Settings, SettingsLoadOutcome } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

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
