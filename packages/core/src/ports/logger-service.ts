/**
 * Diagnostic logging. `cause` carries the error or payload behind the message.
 */
export interface LoggerService {
  error(message: string, cause?: unknown): void
  warn(message: string, cause?: unknown): void
  info(message: string, cause?: unknown): void
}

class ConsoleLoggerImpl implements LoggerService {
  // Rest parameters keep a one-argument call one argument long on the console.
  error(...args: [message: string, cause?: unknown]): void {
    console.error(...args)
  }

  warn(...args: [message: string, cause?: unknown]): void {
    console.warn(...args)
  }

  info(...args: [message: string, cause?: unknown]): void {
    console.info(...args)
  }
}

/**
 * A logger that writes to the global `console`.
 */
export function createConsoleLogger(): LoggerService {
  return new ConsoleLoggerImpl()
}
