import type { DateFormat } from '@reflect/core'
import { useSettingsField } from '@/providers/settings-provider.tsx'

/**
 * The user's date-format setting.
 */
export function useDateFormat(): DateFormat {
  return useSettingsField('dateFormat')
}
