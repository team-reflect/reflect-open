import type { MobileServices } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * The {@link MobileServices} of this webview. The mobile tree runs only on a
 * mobile platform, where `CoreServices.mobile` always exists.
 */
export function useMobileServices(): MobileServices {
  const { mobile } = useCoreServices()
  if (mobile === null) {
    throw new Error('useMobileServices() needs a mobile platform: `CoreServices.mobile` is `null`')
  }
  return mobile
}
