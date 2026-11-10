import type { DeepLinkSource, IpcBridgeService, LoggerService } from '@reflect/core'
import { z } from 'zod'

const urlsSchema = z.array(z.string())

/**
 * `reflect://` delivery through the Swift shell: the launch URLs come from
 * the `host.deep_link_pending` command, later URLs from the `host:open-url`
 * event.
 */
export function createSwiftDeepLinkSource(
  ipc: IpcBridgeService,
  logger: LoggerService,
): DeepLinkSource {
  return {
    onOpenUrl: (listener) => {
      return ipc.listen('host:open-url', (payload) => {
        const urls = urlsSchema.safeParse(payload)
        if (!urls.success) {
          logger.warn('Dropped a malformed host:open-url payload', urls.error)
          return
        }
        listener(urls.data)
      })
    },
    getCurrent: () => ipc.call('host.deep_link_pending', {}, urlsSchema.nullable()),
  }
}
