import { isAppError } from '@reflect/core'

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

/**
 * Render a log line for the shell's log file: the cause is appended to the
 * message, an error as `Name: message` without its stack, other values as JSON.
 */
export function renderLogLine(message: string, cause: unknown): string {
  if (cause === undefined) {
    return message
  }
  const text = renderCause(cause)
  return `${message} ${text.length > MAX_CAUSE_LENGTH ? `${text.slice(0, MAX_CAUSE_LENGTH)}…` : text}`
}
