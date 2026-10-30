import { coreServices, pendingDevIpc } from '@/boot.ts'
import { createDevBridge, type DevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'
import { createDevIndexDb } from '@/dev/dev-index-db.ts'
import { seedGraphFiles } from '@/dev/seed-graph.ts'

async function createDevIpc(): Promise<DevBridge> {
  const index = await createDevIndexDb()
  const files = createDevFileStore(seedGraphFiles())
  return createDevBridge({ files, index })
}

const { appPlatform } = coreServices.platform

if (pendingDevIpc !== null) {
  const bridge = await createDevIpc()
  pendingDevIpc.connect(bridge, bridge)
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
