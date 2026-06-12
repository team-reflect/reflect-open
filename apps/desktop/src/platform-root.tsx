import { lazy, Suspense, useEffect, useState, type ReactElement } from 'react'
import { getAppPlatform, hasBridge, isMobilePlatform, type AppPlatform } from '@reflect/core'

const DesktopRoot = lazy(() =>
  import('@/desktop-root').then((module) => ({ default: module.DesktopRoot })),
)
const MobileRoot = lazy(() =>
  import('@/mobile/mobile-root').then((module) => ({ default: module.MobileRoot })),
)

/**
 * The Plan 19 root gate: one bundle, two surface trees. The shell reports
 * which platform it was built for and the matching tree loads as a lazy
 * chunk — desktop chrome never reaches the mobile critical path, and vice
 * versa. Plain-browser dev (no Tauri bridge) gets the desktop tree.
 */
export function PlatformRoot(): ReactElement {
  const [platform, setPlatform] = useState<AppPlatform | null>(null)

  useEffect(() => {
    if (!hasBridge()) {
      setPlatform('desktop')
      return
    }
    let active = true
    void getAppPlatform()
      .then((resolved) => {
        if (active) {
          setPlatform(resolved)
        }
      })
      .catch(() => {
        if (active) {
          setPlatform('desktop')
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
