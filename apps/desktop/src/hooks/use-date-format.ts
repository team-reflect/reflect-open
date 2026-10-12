import { DEFAULT_SETTINGS, type DateFormat } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * The user's date-format setting. A surface rendered outside a
 * SettingsProvider (an isolated preview) gets the default format.
 */
export function useDateFormat(): DateFormat {
  return useSettings({ optional: true })?.settings.dateFormat ?? DEFAULT_SETTINGS.dateFormat
}
