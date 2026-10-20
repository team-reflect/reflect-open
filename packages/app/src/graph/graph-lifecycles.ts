import {
  createGraphServices,
  isICloudRoot,
  isMobilePlatform,
  openGraphLifecycle,
  type GraphServices,
  type GraphServicesDeps,
  type GraphSession,
  type PlatformFacts,
  type SettingsService,
  type Unlisten,
} from '@reflect/core'
import type { MobileOnboardingService } from './mobile-onboarding-service.ts'

/**
 * What {@link createAppGraphServices} decides the lifecycles of a session from.
 */
export interface AppGraphServicesDeps {
  readonly platform: PlatformFacts
  /**
   * Turns the asset description session on and off with `describeAssets`.
   */
  readonly settings: SettingsService
  /**
   * Turns the iCloud download refresh on and off with the iCloud storage choice.
   */
  readonly mobileOnboarding: MobileOnboardingService
}

/**
 * Run `open` while `active()` holds, re-checked on every `subscribe` notification.
 */
export function whileActive(
  active: () => boolean,
  subscribe: (listener: () => void) => Unlisten,
  open: () => () => void,
): Unlisten {
  let close: (() => void) | null = null
  const follow = (): void => {
    if (active() === (close !== null)) {
      return
    }
    if (close === null) {
      close = open()
    } else {
      close()
      close = null
    }
  }
  const unlisten = subscribe(follow)
  follow()
  return () => {
    unlisten()
    close?.()
    close = null
  }
}

/**
 * The graph-scoped services of `session`. Every window runs the chat session
 * and the attachment catalog watch. Only the main window runs the backup, the
 * iCloud conflict sweeps (iCloud roots), the capture drain, and asset
 * descriptions (desktop, while `describeAssets` is on). The iCloud download
 * refresh runs while the mobile graph is stored in iCloud.
 */
export function createAppGraphServices(
  session: GraphSession,
  deps: GraphServicesDeps,
  { platform, settings, mobileOnboarding }: AppGraphServicesDeps,
): GraphServices {
  const main = session.role === 'main'
  const mobile = isMobilePlatform(platform.appPlatform) || platform.surface.mobileApp
  const services = createGraphServices(session, deps, {
    gitSync: main,
    icloudSync: main && isICloudRoot(session.root),
    capture: main,
    assetDescription: false,
    icloudDownload: false,
    metadataWatch: platform.surface.mobileApp,
  })
  const disposers: Unlisten[] = []
  if (main && !mobile) {
    disposers.push(
      whileActive(
        () => settings.get().describeAssets,
        settings.subscribe,
        () => openGraphLifecycle(session, deps, 'assetDescription'),
      ),
    )
  }
  disposers.push(
    whileActive(
      () => mobileOnboarding.getState().kind === 'icloud',
      mobileOnboarding.subscribe,
      () => openGraphLifecycle(session, deps, 'icloudDownload'),
    ),
  )
  const dispose = (): void => {
    for (const teardown of disposers.splice(0).reverse()) {
      teardown()
    }
  }
  if (session.signal.aborted) {
    dispose()
  } else {
    session.signal.addEventListener('abort', dispose, { once: true })
  }
  return services
}
