import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'
import { getAppPlatform, hasBridge, isMobilePlatform, type AppPlatform } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { warmMobileStorage } from '@/lib/mobile-boot-warm'

const DesktopRoot = lazy(() =>
  import('@/desktop-root').then((module) => ({ default: module.DesktopRoot })),
)
const MobileRoot = lazy(() =>
  import('@/mobile/mobile-root').then((module) => ({ default: module.MobileRoot })),
)

// The platform IPC round-trip is a build-time constant (the Rust shell's
// compile-time platform tag), so it is resolved once and memoized. It must be
// created lazily — at module-evaluation time `installTauriBridge()` in
// main.tsx has not run yet (imports evaluate before the importing module's
// body), so a module-scope `hasBridge()` check is always false and would pin
// every shell, including iOS, to the desktop tree.
let platformPromise: Promise<AppPlatform> | undefined

function resolveAppPlatform(): Promise<AppPlatform> {
  platformPromise ??= getAppPlatform().catch(() => 'desktop' as AppPlatform)
  return platformPromise
}

/**
 * Head start for the boot-critical path, called from `main.tsx` right after
 * the bridge installs — before React's first render reaches the lazy gate
 * below. Resolves the platform IPC and starts fetching the matching surface
 * chunk immediately (the dynamic imports here and in the `lazy()` factories
 * dedupe to one chunk load); on mobile it also kicks the slow
 * iCloud-container resolve so it overlaps the chunk eval and the settings
 * read (see `mobile-boot-warm.ts`). No-op in plain-browser dev: with no
 * bridge the desktop tree renders directly, and the `?platform=ios`
 * override installs its own bridge first.
 */
export function warmPlatformRoot(): void {
  if (!hasBridge()) {
    return
  }
  void resolveAppPlatform().then((platform) => {
    if (isMobilePlatform(platform)) {
      warmMobileStorage()
      void import('@/mobile/mobile-root')
    } else {
      void import('@/desktop-root')
    }
  })
}

// Dev-only `?platform=` override for the plain-browser harness: `ios` (or
// `android`) forces the mobile tree over the dev bridge, so mobile UI work is
// visible without an iOS build; `none` opts out of the dev bridge entirely,
// reproducing the bridgeless render for gate debugging. Statically false in
// production builds, so the check and the dev-bridge chunk are both dead code
// there.
type DevPlatformOverride = AppPlatform | 'none'

const devPlatformOverride: DevPlatformOverride | null = import.meta.env.DEV
  ? readDevPlatformOverride()
  : null

function readDevPlatformOverride(): DevPlatformOverride | null {
  const requested = new URLSearchParams(window.location.search).get('platform')
  return requested === 'ios' || requested === 'android' || requested === 'none' ? requested : null
}

/**
 * The platform the in-browser dev bridge should emulate, or null when it must
 * not install (production build, or the `?platform=none` opt-out). Plain
 * `pnpm dev` in a browser gets the desktop tree over the dev bridge by
 * default — an un-flagged tab boots into a seeded, workable graph instead of
 * a bridgeless empty chooser. Whether a *real* shell is present is decided at
 * the call site via the bridge state: the Tauri bridge installs before the
 * first render, so a bridge at mount time means Tauri, not this harness.
 */
function devBridgePlatform(): AppPlatform | null {
  if (!import.meta.env.DEV || devPlatformOverride === 'none') {
    return null
  }
  return devPlatformOverride ?? 'desktop'
}

/**
 * The Plan 19 root gate: one bundle, two surface trees. The shell reports
 * which platform it was built for and the matching tree loads as a lazy
 * chunk — desktop chrome never reaches the mobile critical path, and vice
 * versa. Plain-browser dev boots the desktop tree over the in-memory dev
 * bridge (or the mobile tree with `?platform=ios`; `?platform=none` renders
 * bridgeless). Dev builds only — production always has the Tauri bridge.
 */
export function PlatformRoot(): ReactElement {
  // This component drives the install itself, so it reads the reactive value
  // once per render rather than sampling `hasBridge()` mid-render.
  const bridgeReady = useBridgeReady()
  // Hold the blank frame while the dev bridge chunk loads in plain-browser
  // dev; render the desktop tree directly when bridgeless (`?platform=none`,
  // production-in-browser). With a bridge, resolve the real platform.
  const [platform, setPlatform] = useState<AppPlatform | null>(() => {
    if (devBridgePlatform() !== null && !bridgeReady) {
      return null
    }
    return bridgeReady ? null : 'desktop'
  })

  useEffect(() => {
    let active = true
    const devPlatform = devBridgePlatform()
    if (devPlatform !== null && !bridgeReady) {
      void import('@/dev/install-dev-bridge')
        .then(async (module) => {
          await module.installDevBridge(devPlatform)
          if (active) {
            setPlatform(devPlatform)
          }
        })
        .catch((cause: unknown) => {
          // Dev-only path: fail loud (the screen would otherwise stay blank)
          // and fall back to the desktop tree rather than hanging.
          console.error('[dev-bridge] install failed:', cause)
          if (active) {
            setPlatform('desktop')
          }
        })
      return () => {
        active = false
      }
    }
    if (!bridgeReady) {
      return
    }
    void resolveAppPlatform().then((resolved) => {
      if (active) {
        setPlatform(resolved)
      }
    })
    return () => {
      active = false
    }
  }, [bridgeReady])

  if (platform === null) {
    return <div className="h-screen w-screen" />
  }

  return (
    <Suspense fallback={<div className="h-screen w-screen" />}>
      {isMobilePlatform(platform) ? <MobileRoot platform={platform} /> : <DesktopRoot />}
    </Suspense>
  )
}
