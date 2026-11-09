import type { LoggerService } from '@reflect/core'

function renderError(error: Error): string {
  const header = `${error.name}: ${error.message}`
  const stack = error.stack
  if (!stack) {
    return header
  }
  // V8 opens the stack with the header line; JavaScriptCore lists frames only.
  return stack.startsWith(header) ? stack : `${header}\n${stack}`
}

/**
 * Write every uncaught error and unhandled rejection of `target` to the log,
 * stack included. This also covers errors raised with `reportError`, which
 * the editor uses for failures it catches in mark views and plugin callbacks.
 * The rendered text goes into the message, because `createTauriLogger` drops
 * the stack of an `Error` cause.
 */
export function installUncaughtErrorLogging(target: EventTarget, logger: LoggerService): void {
  target.addEventListener('error', (event) => {
    const { error, message } = event as Event & { error: unknown; message: string }
    logger.error(`uncaught error: ${error instanceof Error ? renderError(error) : message}`)
  })
  target.addEventListener('unhandledrejection', (event) => {
    const { reason } = event as Event & { reason: unknown }
    logger.error(
      `unhandled rejection: ${reason instanceof Error ? renderError(reason) : String(reason)}`,
    )
  })
}
