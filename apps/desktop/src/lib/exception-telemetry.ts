import type { ExceptionErrorHandler, ExceptionTelemetryService } from '@reflect/app'
import type { BuildPlatform, LoggerService } from '@reflect/core'
import { sha256Hex, withoutUndefined } from '@reflect/utils'
import {
  dedupeIntegration,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
  reactErrorHandler,
} from '@sentry/react'
import type { BrowserOptions, ErrorEvent, Exception, StackFrame } from '@sentry/react'

const REDACTED_VALUE = '[redacted]'
const MAX_EXCEPTION_COUNT = 3
const MAX_STACK_FRAME_COUNT = 50
const REACT_ERROR_BOUNDARY_PREFIX = 'React ErrorBoundary '

// An exception type is a class name. A function name is an identifier path,
// Sentry's `?` for an unknown frame, or a `new` / `async` prefixed name. Both
// come from code, never from a document.
const SAFE_EXCEPTION_TYPE = /^\w{1,64}$/
const SAFE_FUNCTION_NAME = /^(?:(?:async|new) )?[\w$.<>?[\]]{1,120}$/
const SAFE_SCRIPT_BASENAME = /^[\w.-]+\.(?:js|jsx|mjs|ts|tsx)$/

// A source expression as WebKit and V8 print it (identifiers, member access,
// calls, literals copied from the source text, never a runtime value), a bare
// identifier, and the fixed value words an engine prints for a non-callable.
const EXPR = String.raw`[\w$.[\]'"()]{1,160}`
const ID = String.raw`[\w$]{1,64}`
const VALUE = String.raw`(?:undefined|null|true|false|NaN|-?Infinity|-?\d+(?:\.\d+)?|an instance of ${ID})`
const exact = (source: string): RegExp => new RegExp(`^${source}$`)

// Exception messages that cannot carry document data, by exception type. Every
// pattern is anchored and admits only identifiers, source text without spaces,
// or fixed words. A message outside this list is redacted, including every
// `SyntaxError` (`JSON.parse` echoes its input), `DOMException` (Chromium echoes
// arguments), `AppError`, and V8's `Cannot read properties of undefined
// (reading 'x')`, whose `x` is a runtime key.
const SAFE_EXCEPTION_VALUES: Record<string, readonly RegExp[]> = {
  // The fixed string a browser substitutes for an error it will not disclose.
  Error: [/^Script error\.?$/],
  RangeError: [
    /^Maximum call stack size exceeded\.?$/,
    /^Invalid (?:array|string) length$/,
    /^Invalid time value$/,
    /^Out of memory\.?$/,
  ],
  ReferenceError: [
    exact(`Can't find variable: ${ID}`),
    exact(`${ID} is not defined`),
    exact(`Cannot access '${ID}' before initialization`),
  ],
  // The structural StepResult failures emitted by ProseMirror.
  TransformError: [
    /^Cannot join [A-Za-z_]\w* onto [A-Za-z_]\w*$/,
    /^Content does not fit in gap$/,
    /^Gap is not a flat range$/,
    /^Inconsistent open depths$/,
    /^Inserted content deeper than insertion position$/,
    /^Invalid content for node [A-Za-z_]\w*$/,
    /^No node at (?:attribute|mark) step's position$/,
    /^Structure (?:gap-)?replace would overwrite content$/,
  ],
  TypeError: [
    // WebKit
    exact(String.raw`(?:undefined|null) is not an object \(evaluating '${EXPR}'\)`),
    exact(
      String.raw`${EXPR} is not a (?:function|constructor)\. \(In '${EXPR}', '${EXPR}' is ${VALUE}\)`,
    ),
    exact(String.raw`${EXPR} is not a constructor \(evaluating '${EXPR}'\)`),
    /^Attempted to assign to readonly property\.$/,
    /^Load failed$/,
    // V8
    exact(`${EXPR} is not (?:a function|a constructor|iterable)`),
    /^Failed to fetch$/,
    // Both
    /^The operation was aborted\.?$/,
  ],
  URIError: [/^URI error$/, /^URI malformed$/],
}

/**
 * The host OS, as a fixed name for the Sentry `os` tag.
 */
export type TelemetryOs = BuildPlatform | 'unknown'

function getExceptionCauseType(type: string | undefined): string | undefined {
  return type?.startsWith(REACT_ERROR_BOUNDARY_PREFIX)
    ? type.slice(REACT_ERROR_BOUNDARY_PREFIX.length)
    : type
}

function scrubExceptionType(type: string | undefined): string {
  const causeType = getExceptionCauseType(type)
  const safeType = causeType && SAFE_EXCEPTION_TYPE.test(causeType) ? causeType : 'Error'
  return type?.startsWith(REACT_ERROR_BOUNDARY_PREFIX)
    ? `ReactErrorBoundary<${safeType}>`
    : safeType
}

function isSafeExceptionValue(exception: Exception): boolean {
  const causeType = getExceptionCauseType(exception.type)
  const value = exception.value
  if (!causeType || !value) {
    return false
  }
  const patterns = Object.hasOwn(SAFE_EXCEPTION_VALUES, causeType)
    ? SAFE_EXCEPTION_VALUES[causeType]
    : undefined
  return patterns?.some((pattern) => pattern.test(value)) ?? false
}

function safeScriptBasename(filename: string | undefined): string | undefined {
  const pathWithoutQuery = filename?.split(/[?#]/, 1)[0]
  const basename = pathWithoutQuery?.split(/[\\/]/).at(-1)
  return basename && SAFE_SCRIPT_BASENAME.test(basename) ? basename : undefined
}

function scrubFilename(filename: string | undefined): string | undefined {
  if (!filename) {
    return undefined
  }
  return `app:///${safeScriptBasename(filename) ?? REDACTED_VALUE}`
}

function scrubStackFrame(frame: StackFrame): StackFrame {
  const scrubbed: StackFrame = {}
  const filename = scrubFilename(frame.filename)
  if (filename) {
    scrubbed.filename = filename
  }
  if (frame.function && SAFE_FUNCTION_NAME.test(frame.function)) {
    scrubbed.function = frame.function
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
    const basename = image.type === 'sourcemap' ? safeScriptBasename(image.code_file) : undefined
    return basename
      ? [{ type: 'sourcemap' as const, code_file: `app:///${basename}`, debug_id: image.debug_id }]
      : []
  })
  return images?.length ? { images } : undefined
}

function scrubException(exception: Exception): Exception {
  const value = exception.value
  const scrubbed: Exception = {
    type: scrubExceptionType(exception.type),
    value: value && isSafeExceptionValue(exception) ? value : REDACTED_VALUE,
  }
  if (exception.mechanism) {
    const { type, handled, synthetic, exception_id, parent_id, source } = exception.mechanism
    scrubbed.mechanism = withoutUndefined<NonNullable<Exception['mechanism']>>({
      type,
      handled,
      synthetic,
      exception_id,
      parent_id,
      source,
    })
  }
  if (exception.stacktrace?.frames) {
    scrubbed.stacktrace = {
      frames: exception.stacktrace.frames.slice(-MAX_STACK_FRAME_COUNT).map(scrubStackFrame),
    }
  }
  return scrubbed
}

/**
 * Reduce a Sentry error event to the diagnostic allow-list. This deliberately
 * constructs a new event rather than deleting known-sensitive fields so new
 * SDK fields cannot begin leaving the device unnoticed after an upgrade.
 */
export async function scrubExceptionEvent(
  event: ErrorEvent,
  os: TelemetryOs,
): Promise<ErrorEvent | null> {
  const exceptions = event.exception?.values?.slice(-MAX_EXCEPTION_COUNT)
  if (!exceptions?.length) {
    return null
  }

  // Sentry orders linked exceptions cause first; the last one is the error itself.
  const root = exceptions.at(-1)
  // The first 12 hex digits of the SHA-256 of a redacted message tell redacted
  // messages apart without disclosing them; a suspected message is confirmed
  // by hashing it locally.
  const messageHash =
    root?.value && !isSafeExceptionValue(root)
      ? (await sha256Hex(root.value)).slice(0, 12)
      : undefined
  const debugMeta = scrubDebugMeta(event.debug_meta)
  return withoutUndefined<ErrorEvent>({
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    release: event.release,
    environment: event.environment,
    level: 'error',
    platform: 'javascript',
    tags: { runtime: 'tauri-webview', os, ...(messageHash ? { message_hash: messageHash } : {}) },
    exception: { values: exceptions.map(scrubException) },
    ...(debugMeta ? { debug_meta: debugMeta } : {}),
  })
}

/**
 * Build the exception-only Sentry configuration shared by desktop and iOS WebViews.
 */
function createExceptionTelemetryOptions(
  dsn: string,
  release: string,
  os: TelemetryOs,
): BrowserOptions {
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
    sendClientReports: false,
    attachStacktrace: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    normalizeDepth: 1,
    normalizeMaxBreadth: 10,
    maxValueLength: 200,
    enhanceFetchErrorMessages: false,
    beforeSend: (event) => scrubExceptionEvent(event, os),
  }
}

/**
 * The Sentry entry points {@link createExceptionTelemetry} drives.
 */
export interface ExceptionTelemetrySdk {
  init(options: BrowserOptions): void
  reactErrorHandler: typeof reactErrorHandler
}

export const sentryExceptionTelemetrySdk: ExceptionTelemetrySdk = { init, reactErrorHandler }

/**
 * The production DSN baked into this build, or `null` for development builds.
 * It is a build secret of the release workflows, and the WebView CSP limits
 * `connect-src` to Sentry ingest hosts.
 */
export function buildExceptionTelemetryDsn(): string | null {
  const dsn = import.meta.env.PROD ? import.meta.env.VITE_SENTRY_DSN?.trim() : undefined
  return dsn || null
}

export interface ExceptionTelemetryDeps {
  readonly dsn: string | null
  readonly release: string
  readonly os: TelemetryOs
  readonly sdk: ExceptionTelemetrySdk
  readonly logger: LoggerService
}

class ExceptionTelemetryImpl implements ExceptionTelemetryService {
  readonly #deps: ExceptionTelemetryDeps
  #installed = false

  constructor(deps: ExceptionTelemetryDeps) {
    this.#deps = deps
  }

  install(): void {
    const { dsn, release, os, sdk, logger } = this.#deps
    if (dsn === null || this.#installed) {
      return
    }
    this.#installed = true
    try {
      sdk.init(createExceptionTelemetryOptions(dsn, release, os))
    } catch (error) {
      logger.error('[reflect-open] Failed to initialize exception telemetry', error)
    }
  }

  reactRootOptions(): ReturnType<ExceptionTelemetryService['reactRootOptions']> {
    const { dsn, sdk } = this.#deps
    if (dsn === null) {
      return {}
    }
    return {
      onCaughtError: adaptReactErrorHandler(sdk.reactErrorHandler(() => {})),
      onRecoverableError: adaptReactErrorHandler(sdk.reactErrorHandler(() => {})),
      onUncaughtError: adaptReactErrorHandler(sdk.reactErrorHandler()),
    }
  }
}

function adaptReactErrorHandler(
  handler: ReturnType<typeof reactErrorHandler>,
): ExceptionErrorHandler {
  return (error, errorInfo): void => {
    handler(error, { componentStack: errorInfo.componentStack ?? null })
  }
}

/**
 * Exception telemetry over Sentry; disabled when `dsn` is `null`.
 */
export function createExceptionTelemetry(deps: ExceptionTelemetryDeps): ExceptionTelemetryService {
  return new ExceptionTelemetryImpl(deps)
}
