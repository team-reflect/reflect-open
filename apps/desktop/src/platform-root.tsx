import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'
import { getAppPlatform, hasBridge, isMobilePlatform, type AppPlatform } from '@reflect/core'

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

// Dev-only escape hatch: `?platform=ios` (or `android`) in a plain browser
// forces the mobile tree, backed by the in-memory dev bridge, so mobile UI
// work is visible without an iOS build. Statically false in production
// builds, so the check and the dev-bridge chunk are both dead code there.
const devPlatformOverride: AppPlatform | null = import.meta.env.DEV
  ? readDevPlatformOverride()
  : null

function readDevPlatformOverride(): AppPlatform | null {
  const requested = new URLSearchParams(window.location.search).get('platform')
  return requested === 'ios' || requested === 'android' ? requested : null
}

/**
 * The Plan 19 root gate: one bundle, two surface trees. The shell reports
 * which platform it was built for and the matching tree loads as a lazy
 * chunk — desktop chrome never reaches the mobile critical path, and vice
 * versa. Plain-browser dev (no Tauri bridge) gets the desktop tree, unless
 * `?platform=ios` forces the mobile tree over the dev bridge (dev builds only).
 */
export function PlatformRoot(): ReactElement {
  // Plain-browser dev has no bridge — start on the desktop tree directly
  // (or hold the blank frame while the dev bridge chunk loads when a dev
  // platform override is active). With a bridge, resolve the real platform.
  const [platform, setPlatform] = useState<AppPlatform | null>(() => {
    if (import.meta.env.DEV && devPlatformOverride !== null && !hasBridge()) {
      return null
    }
    return hasBridge() ? null : 'desktop'
  })

  useEffect(() => {
    let active = true
    if (import.meta.env.DEV && devPlatformOverride !== null && !hasBridge()) {
      void import('@/dev/install-dev-bridge')
        .then(async (module) => {
          await module.installDevBridge(devPlatformOverride)
          if (active) {
            setPlatform(devPlatformOverride)
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
    if (!hasBridge()) {
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
  }, [])

  if (platform === null) {
    return <div className="h-screen w-screen" />
  }

  return (
    <Suspense fallback={<div className="h-screen w-screen" />}>
      {isMobilePlatform(platform) ? <MobileRoot platform={platform} /> : <DesktopRoot />}
    </Suspense>
  )
}
