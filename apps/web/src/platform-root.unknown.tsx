import type { IpcBridge } from '@reflect/core'

import { coreServices, pendingDevIpc } from '@/boot.ts'
import { createDevAssetStore, type DevAssetStore } from '@/dev/dev-asset-store.ts'
import { createDevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'
import { seedGraphFiles } from '@/dev/seed-graph.ts'

function createDevIpc(assets: DevAssetStore): IpcBridge {
  const files = createDevFileStore(seedGraphFiles())
  return createDevBridge({ files, assets })
}

const { appPlatform } = coreServices.platform

if (pendingDevIpc !== null) {
  const assets = createDevAssetStore()
  pendingDevIpc.connect(createDevIpc(assets), assets)
}

const { PlatformRoot, warmPlatformRoot } = await (async () => {
  if (appPlatform === 'desktop') {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.desktop.tsx')
    return { PlatformRoot, warmPlatformRoot }
  } else {
    const { warmPlatformRoot, PlatformRoot } = await import('@/platform-root.mobile.tsx')
    return { PlatformRoot, warmPlatformRoot }
  }
})()

export { PlatformRoot, warmPlatformRoot }
