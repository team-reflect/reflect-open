import { error, info, warn } from '@tauri-apps/plugin-log'
import { isAppError, type LoggerService } from '@reflect/core'

/**
 * A rendered cause longer than this is cut, so one oversized payload cannot
 * flood the log file.
 */
const MAX_CAUSE_LENGTH = 2000

function renderCause(cause: unknown): string {
  if (isAppError(cause)) {
    return `${cause.name} (${cause.kind}): ${cause.message}`
  }
  if (cause instanceof Error) {
    return String(cause)
  }
  if (typeof cause === 'object' && cause !== null) {
    try {
      return JSON.stringify(cause) ?? String(cause)
    } catch {
      return String(cause)
    }
  }
  return String(cause)
}

function render(message: string, cause: unknown): string {
  if (cause === undefined) {
    return message
  }
  const text = renderCause(cause)
  return `${message} ${text.length > MAX_CAUSE_LENGTH ? `${text.slice(0, MAX_CAUSE_LENGTH)}…` : text}`
}

async function forward(
  write: (message: string) => Promise<void>,
  message: string,
  cause?: unknown,
): Promise<void> {
  try {
    await write(render(message, cause))
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
