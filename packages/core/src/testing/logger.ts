import type { LoggerService } from '../ports/logger-service.ts'

export interface LogEntry {
  readonly message: string
  readonly cause: unknown
}

export interface TestLoggerService extends LoggerService {
  getErrors(): readonly LogEntry[]
  getWarnings(): readonly LogEntry[]
  getInfos(): readonly LogEntry[]
}

class TestLoggerServiceImpl implements TestLoggerService {
  readonly #errors: LogEntry[] = []
  readonly #warnings: LogEntry[] = []
  readonly #infos: LogEntry[] = []

  error(message: string, cause?: unknown): void {
    this.#errors.push({ message, cause })
  }

  warn(message: string, cause?: unknown): void {
    this.#warnings.push({ message, cause })
  }

  info(message: string, cause?: unknown): void {
    this.#infos.push({ message, cause })
  }

  getErrors(): readonly LogEntry[] {
    return [...this.#errors]
  }

  getWarnings(): readonly LogEntry[] {
    return [...this.#warnings]
  }

  getInfos(): readonly LogEntry[] {
    return [...this.#infos]
  }
}

/**
 * A logger that records every entry and prints nothing.
 */
export function createTestLoggerService(): TestLoggerService {
  return new TestLoggerServiceImpl()
}
