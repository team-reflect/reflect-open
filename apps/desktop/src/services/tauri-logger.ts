import { error, info, warn } from '@tauri-apps/plugin-log'
import type { LoggerService } from '@reflect/core'
import { renderLogLine } from '@/services/log-line.ts'

async function forward(
  write: (message: string) => Promise<void>,
  message: string,
  cause?: unknown,
): Promise<void> {
  try {
    await write(renderLogLine(message, cause))
  } catch {
    // A failed forward is dropped: logging it would forward again.
  }
}

/**
 * A logger that writes each line to `inner` and to the shell's log file
 * through `tauri-plugin-log`. The cause is rendered into the message: an
 * error as `Name: message` without its stack, other values as JSON.
 */
export function createTauriLogger(inner: LoggerService): LoggerService {
  return {
    error: (...args) => {
      inner.error(...args)
      void forward(error, ...args)
    },
    warn: (...args) => {
      inner.warn(...args)
      void forward(warn, ...args)
    },
    info: (...args) => {
      inner.info(...args)
      void forward(info, ...args)
    },
  }
}
