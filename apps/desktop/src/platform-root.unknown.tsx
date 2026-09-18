import { hasBridge, setBridge, type AppPlatform } from '@reflect/core'

import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'
import { seedGraphFiles } from '@/dev/seed-graph'
import { lazy, Suspense } from 'react'
import { LoadingScreen } from '@/components/loading-screen'

const appPlatform: AppPlatform = (() => {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const query = new URLSearchParams(window.location.search).get('platform')
    if (query === 'ios') {
      return 'ios'
    }
    if (query === 'android') {
      return 'android'
    }
    if (query === 'desktop') {
      return 'desktop'
    }
    if (query) {
      console.warn('[reflect-open] Unknown platform override in query string:', query)
    }
  }

  const env = import.meta.env.TAURI_ENV_PLATFORM || ''

  switch (env) {
    case 'ios':
      return 'ios'
    case 'android':
      return 'android'
    case 'windows':
    case 'linux':
    case 'darwin':
    case '':
      return 'desktop'
    default:
      console.warn(
        '[reflect-open] Unknown platform in environment variable TAURI_ENV_PLATFORM:',
        env,
      )
      return 'desktop'
  }
})()

const plateformRootPromise = (async () => {
  if (!hasBridge()) {
    const index = await createDevIndexDb()
    const files = createDevFileStore(seedGraphFiles())
    const devBridge = createDevBridge({ platform: appPlatform, files, index })
    setBridge(devBridge)
  }

  if (appPlatform === 'desktop') {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.desktop')
    return { PlatformRoot, warmPlatformRoot }
  } else {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.mobile')
    return { PlatformRoot, warmPlatformRoot }
  }
})()

const PlatformRootLazy = lazy(async () => {
  const { PlatformRoot } = await plateformRootPromise
  return { default: PlatformRoot }
})

export function warmPlatformRoot() {
  plateformRootPromise.then(({ warmPlatformRoot }) => warmPlatformRoot())
}

export function PlatformRoot() {
  ;<Suspense fallback={<LoadingScreen />}>
    <PlatformRootLazy />
  </Suspense>
}
