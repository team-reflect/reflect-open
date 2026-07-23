import { describe, expect, it } from 'vitest'
import type { ErrorEvent } from '@sentry/react'
import {
  createExceptionTelemetryOptions,
  parseExceptionTelemetryDsn,
  scrubExceptionEvent,
} from './exception-telemetry'

describe('parseExceptionTelemetryDsn', () => {
  it('accepts only the production Reflect Sentry project', () => {
    expect(
      parseExceptionTelemetryDsn(
        ' https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200 ',
      ),
    ).toBe(
      'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/4511705649971200',
    )
    expect(
      parseExceptionTelemetryDsn(
        'https://0123456789abcdef0123456789abcdef@evil.example/4511705649971200',
      ),
    ).toBeNull()
    expect(
      parseExceptionTelemetryDsn(
        'https://0123456789abcdef0123456789abcdef@o463484.ingest.us.sentry.io/123',
      ),
    ).toBeNull()
    expect(parseExceptionTelemetryDsn(undefined)).toBeNull()
  })
})

describe('scrubExceptionEvent', () => {
  it('rebuilds exceptions from an allow-list and removes user and request data', () => {
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
              type: 'onerror',
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

    expect(scrubExceptionEvent(event)).toEqual({
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      timestamp: 1_725_000_000,
      release: 'reflect@0.4.0-beta.45',
      environment: 'production',
      level: 'error',
      platform: 'javascript',
      tags: { runtime: 'tauri-webview' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: '[redacted]',
            mechanism: { type: 'onerror', handled: false },
            stacktrace: {
              frames: [
                {
                  filename: 'app:///main-ABC123.js',
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

  it('redacts untrusted types, function names, filenames, mechanisms, and release values', () => {
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'person@example.com',
      release: 'reflect@0.4.0-/Users/alex',
      environment: 'person@example.com',
      exception: {
        values: [
          {
            type: 'Customer Acme',
            value: 'private note text',
            mechanism: { type: 'custom-person@example.com' },
            stacktrace: {
              frames: [
                {
                  filename: '/Users/alex/Notes/Acme.md',
                  function: 'Customer Acme',
                },
              ],
            },
          },
        ],
      },
    }

    expect(scrubExceptionEvent(event)).toEqual({
      type: undefined,
      level: 'error',
      platform: 'javascript',
      tags: { runtime: 'tauri-webview' },
      exception: {
        values: [
          {
            type: 'Error',
            value: '[redacted]',
            mechanism: { type: 'generic' },
            stacktrace: {
              frames: [
                {
                  filename: 'app:///[redacted]',
                },
              ],
            },
          },
        ],
      },
    })
  })

  it('keeps allow-listed ProseMirror transform diagnostics', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          { type: 'TransformError', value: 'Inconsistent open depths' },
          { type: 'TransformError', value: 'Cannot join paragraph onto bullet_list' },
        ],
      },
    }

    expect(scrubExceptionEvent(event)?.exception?.values).toEqual([
      { type: 'TransformError', value: 'Inconsistent open depths' },
      { type: 'TransformError', value: 'Cannot join paragraph onto bullet_list' },
    ])
  })

  it('keeps allow-listed diagnostics for React ErrorBoundary TransformErrors', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            type: 'React ErrorBoundary TransformError',
            value: 'Invalid content for node paragraph',
          },
        ],
      },
    }

    expect(scrubExceptionEvent(event)?.exception?.values).toEqual([
      {
        type: 'ReactErrorBoundary<TransformError>',
        value: 'Invalid content for node paragraph',
      },
    ])
  })

  it('redacts free-form values from otherwise trusted exception types', () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [{ type: 'TransformError', value: 'Private roadmap note content' }],
      },
    }

    expect(scrubExceptionEvent(event)?.exception?.values).toEqual([
      { type: 'TransformError', value: '[redacted]' },
    ])
  })

  it('drops non-exception events', () => {
    expect(scrubExceptionEvent({ type: undefined, message: 'note content' })).toBeNull()
  })
})

describe('createExceptionTelemetryOptions', () => {
  it('enables only exception integrations and disables ambient collection', () => {
    const options = createExceptionTelemetryOptions(
      'https://public@example.ingest.sentry.io/123',
      'reflect@0.4.0-beta.45',
    )

    expect(options.defaultIntegrations).toBe(false)
    expect(options.integrations).toEqual([
      expect.objectContaining({ name: 'GlobalHandlers' }),
      expect.objectContaining({ name: 'LinkedErrors' }),
      expect.objectContaining({ name: 'Dedupe' }),
    ])
    expect(options.maxBreadcrumbs).toBe(0)
    expect(options.tracesSampleRate).toBe(0)
    expect(options.replaysSessionSampleRate).toBe(0)
    expect(options.replaysOnErrorSampleRate).toBe(0)
    expect(options.sendClientReports).toBe(false)
    expect(options.sendDefaultPii).toBe(false)
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    })
  })
})
