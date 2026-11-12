import { appServices, coreServices } from '@/boot.ts'
import { MobileRoot } from '@/mobile/mobile-root.tsx'
import type { ReactElement } from 'react'

const platform = coreServices.platform.appPlatform === 'ios' ? 'ios' : 'android'

/** Starts the slow iCloud-container resolve ahead of the first render. */
export function warmPlatformRoot(): void {
  appServices.mobileOnboarding.warm()
}

export function PlatformRoot(): ReactElement {
  return <MobileRoot platform={platform} />
}
