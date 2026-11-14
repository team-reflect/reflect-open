import type { OpenerTransport } from '@reflect/app'
import type { IpcBridgeService } from '@reflect/core'

/**
 * URL handoff through the Swift shell's `host.open_url` command. iOS has no
 * file manager to reveal a path in.
 */
export function createSwiftOpenerTransport(ipc: IpcBridgeService): OpenerTransport {
  return {
    openUrl: async (url) => {
      await ipc.call('host.open_url', { url })
    },
    revealItemInDir: (path) => {
      throw new Error(`cannot reveal ${path}: iOS has no file manager`)
    },
  }
}
