import type { IpcBridge, LoggerService } from '@reflect/core'
import { renderLogLine } from '@/services/log-line.ts'

async function forward(
  transport: IpcBridge,
  level: 'error' | 'warn' | 'info',
  message: string,
  cause?: unknown,
): Promise<void> {
  try {
    await transport.invoke('host.log', { level, message: renderLogLine(message, cause) })
  } catch {
    // A failed forward is dropped: logging it would forward again.
  }
}

/**
 * A logger that writes each line to `inner` and to the shell's log file
 * through the Swift shell's `host.log` command.
 */
export function createSwiftLogger(inner: LoggerService, transport: IpcBridge): LoggerService {
  return {
    error: (...args) => {
      inner.error(...args)
      void forward(transport, 'error', ...args)
    },
    warn: (...args) => {
      inner.warn(...args)
      void forward(transport, 'warn', ...args)
    },
    info: (...args) => {
      inner.info(...args)
      void forward(transport, 'info', ...args)
    },
  }
}
