import { parseEnvPlatform } from '@/lib/env'
import { warmMobileStorage } from '@/lib/mobile-boot-warm'
import { MobileRoot } from '@/mobile/mobile-root'
import type { ReactElement } from 'react'

const platform = parseEnvPlatform() === 'ios' ? 'ios' : 'android'

/** Starts the slow iCloud-container resolve ahead of the first render. */
export function warmPlatformRoot(): void {
  warmMobileStorage()
}

export function PlatformRoot(): ReactElement {
  return <MobileRoot platform={platform} />
}
