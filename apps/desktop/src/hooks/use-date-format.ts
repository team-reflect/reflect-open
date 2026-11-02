import type { DateFormat } from '@reflect/core'
import { useSetting } from '@/providers/settings-provider.tsx'

/**
 * The user's date-format setting.
 */
export function useDateFormat(): DateFormat {
  return useSetting('dateFormat')
}
