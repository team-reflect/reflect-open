import { emitTo } from '@tauri-apps/api/event'
import { getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { MAIN_WINDOW_LABEL, type WindowHost } from '@reflect/app'
import type { LoggerService, Unlisten } from '@reflect/core'

type CloseRequestedHandler = Parameters<WindowHost['onCloseRequested']>[0]

function currentLabel(logger: LoggerService): string {
  try {
    return getCurrentWindow().label
  } catch (cause) {
    // A misclassified note window would boot the main-window singletons, so say so loudly.
    logger.warn('window label unavailable; assuming the main window:', cause)
    return MAIN_WINDOW_LABEL
  }
}

async function focusedLabel(): Promise<string | null> {
  const windows = await getAllWebviewWindows()
  const focused = await Promise.all(
    windows.map(async (window) => {
      try {
        return (await window.isFocused()) ? window.label : null
      } catch {
        // A window can close between enumeration and the focus check.
        return null
      }
    }),
  )
  return focused.find((label) => label !== null) ?? null
}

export interface TauriWindowHostDeps {
  readonly multiWindow: boolean
  readonly logger: LoggerService
}

class TauriWindowHostImpl implements WindowHost {
  readonly label: string
  readonly multiWindow: boolean

  constructor(deps: TauriWindowHostDeps) {
    this.label = currentLabel(deps.logger)
    this.multiWindow = deps.multiWindow
  }

  async setTitle(title: string): Promise<void> {
    await getCurrentWindow().setTitle(title)
  }

  focusedWindowLabel(): Promise<string | null> {
    return focusedLabel()
  }

  async emitTo(label: string, event: string, payload: unknown): Promise<void> {
    await emitTo({ kind: 'WebviewWindow', label }, event, payload)
  }

  async listen(event: string, handler: (payload: unknown) => void): Promise<Unlisten> {
    return await getCurrentWebviewWindow().listen<unknown>(event, ({ payload }) => {
      handler(payload)
    })
  }

  async onCloseRequested(handler: CloseRequestedHandler): Promise<Unlisten> {
    return await getCurrentWindow().onCloseRequested(handler)
  }

  async hide(): Promise<void> {
    await getCurrentWindow().hide()
  }
}

/**
 * The Tauri webview window this script runs in.
 */
export function createTauriWindowHost(deps: TauriWindowHostDeps): WindowHost {
  return new TauriWindowHostImpl(deps)
}
