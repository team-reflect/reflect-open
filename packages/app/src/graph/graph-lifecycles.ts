import {
  createGraphServices,
  deriveStore,
  isICloudRoot,
  isMobilePlatform,
  openGraphLifecycle,
  type GraphServices,
  type GraphServicesDeps,
  type GraphSession,
  type PlatformFacts,
  type Settings,
  type SettingsService,
  type Store,
  type Unlisten,
} from '@reflect/core'
import type { MobileOnboardingService, MobileOnboardingState } from './mobile-onboarding-service.ts'

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

function selectDescribeAssets(settings: Settings): boolean {
  return settings.describeAssets
}

function selectIsIcloud(state: MobileOnboardingState): boolean {
  return state.kind === 'icloud'
}

/**
 * Run `open` while `active` holds, re-checked on every notification.
 */
export function whileActive(active: Store<boolean>, open: () => () => void): Unlisten {
  let close: (() => void) | null = null
  const follow = (): void => {
    if (active.get() === (close !== null)) {
      return
    }
    if (close === null) {
      close = open()
    } else {
      close()
      close = null
    }
  }
  const unlisten = active.subscribe(follow)
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
      whileActive(deriveStore(settings, selectDescribeAssets), () => {
        return openGraphLifecycle(session, deps, 'assetDescription')
      }),
    )
  }
  disposers.push(
    whileActive(deriveStore(mobileOnboarding, selectIsIcloud), () => {
      return openGraphLifecycle(session, deps, 'icloudDownload')
    }),
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
