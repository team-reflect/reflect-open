import type { ReactElement } from 'react'
import type { AppPlatform } from '@reflect/core'
import { warmMobileStorage } from '@/lib/mobile-boot-warm'
import { MobileRoot } from '@/mobile/mobile-root'

// `armv7-linux-androideabi` makes the Tauri CLI report `androideabi`.
const platform: AppPlatform = import.meta.env.TAURI_ENV_PLATFORM?.startsWith('android')
  ? 'android'
  : 'ios'

/** Starts the slow iCloud-container resolve ahead of the first render. */
export function warmPlatformRoot(): void {
  warmMobileStorage()
}

export function PlatformRoot(): ReactElement {
  return <MobileRoot platform={platform} />
}
