import { hasBridge, setBridge, type AppPlatform } from '@reflect/core'

import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'
import { seedGraphFiles } from '@/dev/seed-graph'


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
      console.warn("[reflect-open] Unknown platform override in query string:", query)
    }
  }


  const env = import.meta.env.TAURI_ENV_PLATFORM || ""

  switch (env) {
    case 'ios':
      return 'ios'
    case 'android':
      return  'android'
    case 'windows':
    case 'linux':
    case 'darwin':
      case "":
      return 'desktop'
    default:
      console.warn("[reflect-open] Unknown platform in environment variable TAURI_ENV_PLATFORM:", env)
      return 'desktop'
  }
})()




if (!hasBridge()) {
  const index = await createDevIndexDb()
  const files = createDevFileStore(seedGraphFiles())
  const devBridge = createDevBridge({ platform: appPlatform, files, index })
  setBridge(devBridge)
}


const { warmPlatformRoot, PlatformRoot} = appPlatform === 'desktop' ? (await import('@/platform-root.desktop'))  : (await import('@/platform-root.mobile'))

export { PlatformRoot, warmPlatformRoot }
