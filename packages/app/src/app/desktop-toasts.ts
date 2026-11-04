import {
  deriveStore,
  marketingVersion,
  type LoggerService,
  type PlatformFacts,
  type Unlisten,
} from '@reflect/core'
import type { WhatsNewService } from '../whats-new/whats-new-service.ts'
import { getWhatsNewToasts } from '../whats-new/whats-new-toasts.ts'
import { getOperationToast } from './operation-toasts.ts'
import type { OperationsService } from './operations-service.ts'
import { syncToasts, type ToastService } from './toast-service.ts'
import { getUpdateToasts } from './update-toasts.ts'
import type { UpdateService } from './update-service.ts'

export interface DesktopToastsDeps {
  readonly toasts: ToastService
  readonly update: UpdateService
  readonly operations: OperationsService
  readonly whatsNew: WhatsNewService
  readonly platform: PlatformFacts
  readonly logger: LoggerService
}

/**
 * Shows the desktop toasts that mirror app state: the update, the background
 * operations, and the What's New offer. Each source syncs on its own, so a
 * change in one never shows the toasts of another again. Returns the function
 * that stops them.
 */
export function syncDesktopToasts(deps: DesktopToastsDeps): Unlisten {
  const { toasts, update, operations, whatsNew, platform, logger } = deps
  const version = marketingVersion(platform.appVersion)
  const stops = [
    syncToasts(
      deriveStore(update, (state) => getUpdateToasts(state, update, logger)),
      toasts,
    ),
    syncToasts(
      deriveStore(operations, (list) => {
        return list.map((operation) => getOperationToast(operation, logger))
      }),
      toasts,
    ),
    syncToasts(
      deriveStore(whatsNew.phase, (phase) => getWhatsNewToasts(phase, version, whatsNew)),
      toasts,
    ),
  ]
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}
