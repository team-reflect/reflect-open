import type { Settings, SettingsService, Store } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useStore, useSelector } from '@/lib/use-store.ts'
import { useCallback } from 'react'
import { isDeepEqual } from '@ocavue/utils'

export function useSettingsService(): SettingsService {
  return useCoreServices().settings satisfies Store<Settings>
}

export function useSettingsStore(): Settings {
  const store = useSettingsService()
  return useStore(store)
}

function useSettingsSelector<T>(selector: (settings: Settings) => T): T {
  const store = useSettingsService()
  return useSelector(store, selector, isDeepEqual)
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
