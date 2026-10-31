import type { DateFormat } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * The user's date-format setting.
 */
export function useDateFormat(): DateFormat {
  return useSettings().settings.dateFormat
}
