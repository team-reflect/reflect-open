import { appServices, coreServices } from '@/boot.ts'
import { MobileRoot } from '@/mobile/mobile-root.tsx'
import type { ReactElement } from 'react'

const platform = coreServices.platform.appPlatform === 'ios' ? 'ios' : 'android'

/**
 * Starts the slow iCloud-container resolve ahead of the first render, and on
 * an iPad the size-class read that picks the workspace or the phone shell.
 * Marks the document as the touch-first app for the `touch-app:` variant,
 * which shows the controls the desktop reveals on hover.
 */
export function warmPlatformRoot(): void {
  document.documentElement.toggleAttribute('data-touch-app', true)
  appServices.mobileOnboarding.warm()
  appServices.sizeClass.start()
}

export function PlatformRoot(): ReactElement {
  return <MobileRoot platform={platform} />
}
