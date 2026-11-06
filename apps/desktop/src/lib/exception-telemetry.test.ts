import { describe, expect, it } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'
import type { BrowserOptions, ErrorEvent, Exception } from '@sentry/react'
import {
  createExceptionTelemetry,
  type ExceptionTelemetrySdk,
  scrubExceptionEvent,
} from './exception-telemetry.ts'

function exceptionEvent(values: Exception[]): ErrorEvent {
  return { type: undefined, exception: { values } }
}

async function scrubValues(values: Exception[]): Promise<Array<Exception | undefined>> {
  return await Promise.all(
    values.map(async (value) => {
      const scrubbed = await scrubExceptionEvent(exceptionEvent([value]), 'darwin')
      return scrubbed?.exception?.values?.[0]
    }),
  )
}

describe('scrubExceptionEvent', () => {
  it('rebuilds exceptions from an allow-list and removes user and request data', async () => {
    const event: ErrorEvent = {
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1_725_000_000,
      release: 'reflect@0.4.0-beta.45',
      environment: 'production',
      message: 'Could not open /Users/alex/Notes/Customers/Acme.md',
      transaction: '/Users/alex/Notes',
      user: { id: 'user-123', email: 'person@example.com', ip_address: '192.0.2.1' },
      request: {
        url: 'https://api.example.test/graphs/alex',
        data: { note: 'A private note' },
        headers: { authorization: 'Bearer secret' },
      },
      breadcrumbs: [{ message: 'Opened Acme', data: { path: '/Users/alex/Notes' } }],
      contexts: { graph: { title: 'Customers' } },
      extra: { noteContent: 'A private note' },
      tags: { graphId: 'graph-123' },
      modules: { privatePlugin: '1.0.0' },
      fingerprint: ['person@example.com'],
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            code_file: 'file:///Users/alex/reflect/dist/assets/main-ABC123.js',
            debug_id: '12345678-1234-1234-1234-123456789abc',
          },
          {
            type: 'sourcemap',
            code_file: '/Users/alex/Notes/Customers/Acme.md',
            debug_id: 'person@example.com',
          },
        ],
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'Customer “Acme” failed at /Users/alex/Notes/Customers/Acme.md',
            mechanism: {
              type: 'auto.browser.global_handlers.onerror',
              handled: false,
              data: { target: 'person@example.com' },
            },
            stacktrace: {
              frames: [
                {
                  filename: 'file:///Users/alex/reflect/dist/assets/main-ABC123.js?graph=Customers',
                  function: 'openDailyNote',
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                  abs_path: '/Users/alex/reflect/dist/assets/main-ABC123.js',
                  context_line: 'throw new Error(note.title)',
                  pre_context: ['const title = note.title'],
                  post_context: ['sendRequest(note.content)'],
                  vars: { title: 'Acme' },
                },
              ],
            },
          },
        ],
      },
    }

    const scrubbed = await scrubExceptionEvent(event, 'darwin')

    expect(scrubbed?.tags?.message_hash).toMatch(/^[0-9a-f]{12}$/)
    expect(scrubbed).toEqual({
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1_725_000_000,
      release: 'reflect@0.4.0-beta.45',
      environment: 'production',
      level: 'error',
      platform: 'javascript',
      tags: { runtime: 'tauri-webview', os: 'darwin', message_hash: scrubbed?.tags?.message_hash },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: '[redacted]',
            mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
            stacktrace: {
              frames: [
                {
                  filename: 'app:///main-ABC123.js',
                  function: 'openDailyNote',
                  lineno: 42,
                  colno: 7,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            code_file: 'app:///main-ABC123.js',
            debug_id: '12345678-1234-1234-1234-123456789abc',
          },
        ],
      },
    })
  })

  it('redacts untrusted types, function names, and filenames', async () => {
    const event = exceptionEvent([
      {
        type: 'Customer Acme',
        value: 'private note text',
        mechanism: { type: 'custom', handled: true },
        stacktrace: {
          frames: [{ filename: '/Users/alex/Notes/Acme.md', function: 'Customer Acme' }],
        },
      },
    ])

    await expect(scrubValues(event.exception?.values ?? [])).resolves.toEqual([
      {
        type: 'Error',
        value: '[redacted]',
        mechanism: { type: 'custom', handled: true },
        stacktrace: { frames: [{ filename: 'app:///[redacted]' }] },
      },
    ])
  })

  it('keeps identifier-like function names', async () => {
    const names = [
      'preMatch',
      'HostElement.disconnectedCallback',
      'new EditorView',
      'async flush',
      '<anonymous>',
      '?',
    ]
    const values = await scrubValues([
      { type: 'Error', stacktrace: { frames: names.map((name) => ({ function: name })) } },
    ])

    expect(values?.[0]?.stacktrace?.frames?.map((frame) => frame.function)).toEqual(names)
  })

  it('keeps engine messages that contain only source text', async () => {
    const safe = [
      { type: 'Error', value: 'Script error.' },
      {
        type: 'TypeError',
        value: "undefined is not an object (evaluating 'curDesc.parent.children')",
      },
      { type: 'TypeError', value: "null is not an object (evaluating 'a[0].b')" },
      {
        type: 'TypeError',
        value: "view.destroy is not a function. (In 'view.destroy()', 'view.destroy' is undefined)",
      },
      {
        type: 'TypeError',
        value: "a.b is not a function. (In 'a.b()', 'a.b' is an instance of Object)",
      },
      { type: 'TypeError', value: 'editor.use is not a function' },
      { type: 'TypeError', value: 'Load failed' },
      { type: 'ReferenceError', value: "Can't find variable: requestIdleCallback" },
      { type: 'ReferenceError', value: 'requestIdleCallback is not defined' },
      { type: 'RangeError', value: 'Maximum call stack size exceeded.' },
      { type: 'TransformError', value: 'Inconsistent open depths' },
      { type: 'TransformError', value: 'Cannot join paragraph onto bullet_list' },
      { type: 'React ErrorBoundary TransformError', value: 'Invalid content for node paragraph' },
    ]

    await expect(scrubValues(safe)).resolves.toEqual(
      safe.map(({ type, value }) => ({
        type: type.startsWith('React ErrorBoundary ') ? 'ReactErrorBoundary<TransformError>' : type,
        value,
      })),
    )
  })

  it('redacts messages that can echo input', async () => {
    const unsafe = [
      { type: 'TypeError', value: 'Script error.' },
      { type: 'Error', value: 'Could not open /Users/alex/Notes/Acme.md' },
      { type: 'AppError', value: 'The [[Acme]] backlink target could not be resolved.' },
      { type: 'SyntaxError', value: 'JSON Parse error: Unexpected identifier "Acme"' },
      { type: 'DOMException', value: "'#Acme' is not a valid selector." },
      { type: 'TypeError', value: "Cannot read properties of undefined (reading 'Acme')" },
      { type: 'TypeError', value: "Cannot set properties of undefined (setting 'Acme')" },
      { type: 'TypeError', value: 'Acme Corp roadmap is not a function' },
      { type: 'TypeError', value: `x is not a function. (In 'x()', 'x' is "Acme roadmap")` },
      { type: 'TypeError', value: "undefined is not an object (evaluating 'a'); see /Users/alex" },
      { type: 'TransformError', value: 'Private roadmap note content' },
    ]

    await expect(scrubValues(unsafe)).resolves.toEqual(
      unsafe.map(({ type }) => ({ type, value: '[redacted]' })),
    )
  })

  it('tags a redacted root message with a stable hash', async () => {
    const first = await scrubExceptionEvent(
      exceptionEvent([
        { type: 'Error', value: 'Cause' },
        { type: 'Error', value: 'Acme' },
      ]),
      'ios',
    )
    const second = await scrubExceptionEvent(
      exceptionEvent([{ type: 'Error', value: 'Acme' }]),
      'ios',
    )
    const safe = await scrubExceptionEvent(
      exceptionEvent([{ type: 'Error', value: 'Script error.' }]),
      'ios',
    )

    expect(first?.tags?.message_hash).toBe('37036cd8f974')
    expect(second?.tags?.message_hash).toBe('37036cd8f974')
    expect(safe?.tags).toEqual({ runtime: 'tauri-webview', os: 'ios' })
  })

  it('drops non-exception events', async () => {
    await expect(
      scrubExceptionEvent({ type: undefined, message: 'note content' }, 'darwin'),
    ).resolves.toBeNull()
  })
})

const DSN = 'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200'

interface HandledError {
  readonly error: unknown
  readonly componentStack: string | null
  readonly callback: boolean
}

function createFakeSdk(options?: { initError?: Error }): ExceptionTelemetrySdk & {
  inits: BrowserOptions[]
  handled: HandledError[]
} {
  const inits: BrowserOptions[] = []
  const handled: HandledError[] = []
  return {
    inits,
    handled,
    init(browserOptions) {
      if (options?.initError !== undefined) {
        throw options.initError
      }
      inits.push(browserOptions)
    },
    reactErrorHandler(callback) {
      return (error, errorInfo) => {
        handled.push({
          error,
          componentStack: errorInfo.componentStack ?? null,
          callback: callback !== undefined,
        })
      }
    },
  }
}

describe('createExceptionTelemetry', () => {
  it('initializes the SDK once with the release and scrubs through `beforeSend`', async () => {
    const sdk = createFakeSdk()
    const telemetry = createExceptionTelemetry({
      dsn: DSN,
      release: 'reflect@1.2.3',
      os: 'darwin',
      sdk,
      logger: createTestLoggerService(),
    })

    telemetry.install()
    telemetry.install()

    expect(sdk.inits).toHaveLength(1)
    expect(sdk.inits[0]).toMatchObject({ dsn: DSN, release: 'reflect@1.2.3' })
    const scrubbed = await sdk.inits[0]?.beforeSend?.(
      exceptionEvent([{ type: 'Error', value: 'Acme' }]),
      {},
    )
    expect(scrubbed?.tags).toEqual({
      runtime: 'tauri-webview',
      os: 'darwin',
      message_hash: '37036cd8f974',
    })
  })

  it('logs an SDK that fails to initialize', () => {
    const failure = new Error('init failed')
    const logger = createTestLoggerService()
    createExceptionTelemetry({
      dsn: DSN,
      release: 'reflect@1.2.3',
      os: 'darwin',
      sdk: createFakeSdk({ initError: failure }),
      logger,
    }).install()

    expect(logger.getErrors()).toEqual([
      { message: '[reflect-open] Failed to initialize exception telemetry', cause: failure },
    ])
  })

  it('reports React root errors through the SDK handlers', () => {
    const sdk = createFakeSdk()
    const options = createExceptionTelemetry({
      dsn: DSN,
      release: 'reflect@1.2.3',
      os: 'darwin',
      sdk,
      logger: createTestLoggerService(),
    }).reactRootOptions()
    const error = new Error('render failed')

    options.onCaughtError?.(error, { componentStack: 'at App' })
    options.onUncaughtError?.(error, {})

    expect(sdk.handled).toEqual([
      { error, componentStack: 'at App', callback: true },
      { error, componentStack: null, callback: false },
    ])
  })

  it('does nothing without a DSN', () => {
    const sdk = createFakeSdk()
    const telemetry = createExceptionTelemetry({
      dsn: null,
      release: 'reflect@1.2.3',
      os: 'darwin',
      sdk,
      logger: createTestLoggerService(),
    })

    telemetry.install()

    expect(sdk.inits).toEqual([])
    expect(telemetry.reactRootOptions()).toEqual({})
  })
})
