import type { ConfirmOptions, DialogService } from '@reflect/app'
import type { IpcBridgeService } from '@reflect/core'

class SwiftDialogServiceImpl implements DialogService {
  readonly #ipc: IpcBridgeService

  constructor(ipc: IpcBridgeService) {
    this.#ipc = ipc
  }

  pickFiles(): readonly string[] | null {
    return null
  }

  pickFolder(): string | null {
    return null
  }

  confirm(options: ConfirmOptions): Promise<boolean> {
    return this.#ipc.call('plugin:mobile-dialog|confirm', options)
  }
}

/**
 * System alerts through the Swift shell's `plugin:mobile-dialog` command. iOS
 * has no open panel for a path, so every picker reads as a cancel.
 */
export function createSwiftDialogService(ipc: IpcBridgeService): DialogService {
  return new SwiftDialogServiceImpl(ipc)
}
