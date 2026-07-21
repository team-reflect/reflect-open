import {
  dedupeIntegration,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
  reactErrorHandler,
} from '@sentry/react'
import type { BrowserOptions, ErrorEvent, Exception, StackFrame } from '@sentry/react'
import type { RootOptions } from 'react-dom/client'
import { z } from 'zod'

const REDACTED_VALUE = '[redacted]'
const MAX_EXCEPTION_COUNT = 3
const MAX_STACK_FRAME_COUNT = 50
const REACT_ERROR_BOUNDARY_PREFIX = 'React ErrorBoundary '

const SAFE_EXCEPTION_TYPES = new Set([
  'AbortError',
  'AggregateError',
  'DOMException',
  'Error',
  'EvalError',
  'NetworkError',
  'NotAllowedError',
  'NotFoundError',
  'QuotaExceededError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TransformError',
  'TypeError',
  'URIError',
])

const SAFE_MECHANISM_TYPES = new Set([
  'auto.function.react.error_handler',
  'generic',
  'onerror',
  'onunhandledrejection',
])

const SAFE_SCRIPT_BASENAME = /^[A-Za-z0-9_.-]+\.(?:js|jsx|mjs|ts|tsx)$/
// These are the structural StepResult failures emitted by ProseMirror. Unknown or
// newly introduced TransformError values stay redacted until they are audited.
const SAFE_TRANSFORM_ERROR_VALUES = [
  /^Cannot join [A-Za-z_][A-Za-z0-9_]* onto [A-Za-z_][A-Za-z0-9_]*$/,
  /^Content does not fit in gap$/,
  /^Gap is not a flat range$/,
  /^Inconsistent open depths$/,
  /^Inserted content deeper than insertion position$/,
  /^Invalid content for node [A-Za-z_][A-Za-z0-9_]*$/,
  /^No node at (?:attribute|mark) step's position$/,
  /^Structure (?:gap-)?replace would overwrite content$/,
]
const SAFE_RELEASE = /^reflect@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/
const SAFE_EVENT_ID = /^[a-f0-9]{32}$/
const SAFE_DEBUG_ID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/
const SENTRY_DSN_SCHEMA = z
  .url()
  .transform((value) => new URL(value))
  .refine(
    (url) =>
      url.protocol === 'https:' &&
      url.hostname === 'o463484.ingest.us.sentry.io' &&
      url.pathname === '/4511705649971200' &&
      /^[a-f0-9]{32}$/.test(url.username) &&
      !url.password &&
      !url.search &&
      !url.hash,
  )
  .transform((url) => url.toString())

/** Accept only the production Reflect Sentry project DSN, while allowing public-key rotation. */
export function parseExceptionTelemetryDsn(value: string | undefined): string | null {
  const parsed = SENTRY_DSN_SCHEMA.safeParse(value?.trim())
  return parsed.success ? parsed.data : null
}

function getExceptionCauseType(type: string | undefined): string | undefined {
  return type?.startsWith(REACT_ERROR_BOUNDARY_PREFIX)
    ? type.slice(REACT_ERROR_BOUNDARY_PREFIX.length)
    : type
}

function scrubExceptionType(type: string | undefined): string {
  const causeType = getExceptionCauseType(type)
  if (type?.startsWith(REACT_ERROR_BOUNDARY_PREFIX)) {
    return causeType && SAFE_EXCEPTION_TYPES.has(causeType)
      ? `ReactErrorBoundary<${causeType}>`
      : 'ReactErrorBoundary<Error>'
  }
  return causeType && SAFE_EXCEPTION_TYPES.has(causeType) ? causeType : 'Error'
}

function scrubExceptionValue(exception: Exception): string {
  const value = exception.value
  if (
    getExceptionCauseType(exception.type) === 'TransformError' &&
    value &&
    SAFE_TRANSFORM_ERROR_VALUES.some((pattern) => pattern.test(value))
  ) {
    return value
  }
  return REDACTED_VALUE
}

function scrubFilename(filename: string | undefined): string | undefined {
  if (!filename) {
    return undefined
  }
  const pathWithoutQuery = filename.split(/[?#]/, 1)[0]
  const basename = pathWithoutQuery?.split(/[\\/]/).at(-1)
  return basename && SAFE_SCRIPT_BASENAME.test(basename)
    ? `app:///${basename}`
    : `app:///${REDACTED_VALUE}`
}

function scrubStackFrame(frame: StackFrame): StackFrame {
  const scrubbed: StackFrame = {}
  const filename = scrubFilename(frame.filename)
  if (filename) {
    scrubbed.filename = filename
  }
  if (typeof frame.lineno === 'number' && Number.isFinite(frame.lineno)) {
    scrubbed.lineno = frame.lineno
  }
  if (typeof frame.colno === 'number' && Number.isFinite(frame.colno)) {
    scrubbed.colno = frame.colno
  }
  if (typeof frame.in_app === 'boolean') {
    scrubbed.in_app = frame.in_app
  }
  return scrubbed
}

function scrubDebugMeta(debugMeta: ErrorEvent['debug_meta']): ErrorEvent['debug_meta'] {
  const images = debugMeta?.images?.flatMap((image) => {
    if (image.type !== 'sourcemap' || !SAFE_DEBUG_ID.test(image.debug_id)) {
      return []
    }
    const codeFile = scrubFilename(image.code_file)
    return codeFile ? [{ type: 'sourcemap' as const, code_file: codeFile, debug_id: image.debug_id }] : []
  })
  return images?.length ? { images } : undefined
}

function scrubException(exception: Exception): Exception {
  const scrubbed: Exception = {
    type: scrubExceptionType(exception.type),
    value: scrubExceptionValue(exception),
  }
  if (exception.mechanism) {
    scrubbed.mechanism = {
      type: SAFE_MECHANISM_TYPES.has(exception.mechanism.type)
        ? exception.mechanism.type
        : 'generic',
      ...(typeof exception.mechanism.handled === 'boolean'
        ? { handled: exception.mechanism.handled }
        : {}),
    }
  }
  if (exception.stacktrace?.frames) {
    scrubbed.stacktrace = {
      frames: exception.stacktrace.frames
        .slice(-MAX_STACK_FRAME_COUNT)
        .map(scrubStackFrame),
    }
  }
  return scrubbed
}

/**
 * Reduce a Sentry error event to the diagnostic allow-list. This deliberately
 * constructs a new event rather than deleting known-sensitive fields so new
 * SDK fields cannot begin leaving the device unnoticed after an upgrade.
 */
export function scrubExceptionEvent(event: ErrorEvent): ErrorEvent | null {
  const exceptions = event.exception?.values
  if (!exceptions?.length) {
    return null
  }

  const debugMeta = scrubDebugMeta(event.debug_meta)
  return {
    type: undefined,
    level: 'error',
    platform: 'javascript',
    tags: { runtime: 'tauri-webview' },
    exception: {
      values: exceptions.slice(-MAX_EXCEPTION_COUNT).map(scrubException),
    },
    ...(event.event_id && SAFE_EVENT_ID.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
      ? { timestamp: event.timestamp }
      : {}),
    ...(event.release && SAFE_RELEASE.test(event.release) ? { release: event.release } : {}),
    ...(event.environment === 'production' ? { environment: 'production' } : {}),
    ...(debugMeta ? { debug_meta: debugMeta } : {}),
  }
}

/** Build the exception-only Sentry configuration shared by desktop and iOS WebViews. */
export function createExceptionTelemetryOptions(dsn: string, release: string): BrowserOptions {
  return {
    dsn,
    release,
    environment: 'production',
    defaultIntegrations: false,
    integrations: [
      globalHandlersIntegration(),
      linkedErrorsIntegration({ limit: 2 }),
      dedupeIntegration(),
    ],
    sampleRate: 1,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    sendClientReports: false,
    enableLogs: false,
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    normalizeDepth: 1,
    normalizeMaxBreadth: 10,
    maxValueLength: 200,
    enhanceFetchErrorMessages: false,
    beforeSend: scrubExceptionEvent,
    beforeSendTransaction: () => null,
  }
}

/**
 * Start production exception telemetry before app bootstrap and return the
 * React 19 root handlers which capture render and recovery failures.
 */
export function initializeExceptionTelemetry(): RootOptions {
  const dsn = parseExceptionTelemetryDsn(import.meta.env.VITE_SENTRY_DSN)
  if (!import.meta.env.PROD || !dsn) {
    return {}
  }

  try {
    init(createExceptionTelemetryOptions(dsn, `reflect@${__REFLECT_VERSION__}`))
  } catch {
    return {}
  }
  const adaptReactErrorHandler = (
    handler: ReturnType<typeof reactErrorHandler>,
  ): ((error: unknown, errorInfo: { componentStack?: string | undefined }) => void) => {
    return (error, errorInfo): void => {
      handler(error, { componentStack: errorInfo.componentStack ?? null })
    }
  }
  return {
    onCaughtError: adaptReactErrorHandler(reactErrorHandler(() => {})),
    onRecoverableError: adaptReactErrorHandler(reactErrorHandler(() => {})),
    onUncaughtError: adaptReactErrorHandler(reactErrorHandler()),
  }
}
