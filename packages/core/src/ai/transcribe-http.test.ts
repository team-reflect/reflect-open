import { describe, expect, it } from 'vitest'
import {
  httpError,
  isTranscriptionOversize,
  isTranscriptionRejected,
  send,
} from './transcribe-http'

const googleInvalidKey = JSON.stringify({
  error: {
    status: 'INVALID_ARGUMENT',
    message: 'API key not valid. Please pass a valid API key.',
  },
})

const googleBadAudio = JSON.stringify({
  error: { status: 'INVALID_ARGUMENT', message: 'Unable to process the provided audio.' },
})

describe('httpError', () => {
  it('classifies 401/403 as auth for both providers', () => {
    expect(httpError('openai', 401, '').kind).toBe('auth')
    expect(httpError('openai', 403, '').kind).toBe('auth')
    expect(httpError('google', 403, '').kind).toBe('auth')
  })

  it('classifies an invalid Gemini key 400 as auth, never a rejection', () => {
    const error = httpError('google', 400, googleInvalidKey)
    expect(error.kind).toBe('auth')
    expect(isTranscriptionRejected(error)).toBe(false)
  })

  it('keeps other google 400s as recording rejections', () => {
    expect(isTranscriptionRejected(httpError('google', 400, googleBadAudio))).toBe(true)
  })

  it('never reads an openai 400 as an invalid key', () => {
    expect(isTranscriptionRejected(httpError('openai', 400, googleInvalidKey))).toBe(true)
  })

  it('classifies 413 as oversize, never a tombstone', () => {
    const error = httpError('openai', 413, 'Maximum content size limit exceeded')
    expect(isTranscriptionOversize(error)).toBe(true)
    expect(isTranscriptionRejected(error)).toBe(false)
  })

  it('keeps 402, 404, 408, 429, and 5xx retryable', () => {
    for (const status of [402, 404, 408, 429, 500, 503]) {
      const error = httpError('openai', status, '')
      expect(error.kind).toBe('network')
      expect(isTranscriptionRejected(error)).toBe(false)
    }
  })

  it('condemns the remaining 4xx as rejections', () => {
    expect(isTranscriptionRejected(httpError('openai', 400, 'bad container'))).toBe(true)
    expect(isTranscriptionRejected(httpError('openai', 422, ''))).toBe(true)
  })
})

describe('send', () => {
  it('reports the Tauri HTTP plugin cancellation as a timeout', async () => {
    const fetchFn = (() => Promise.reject(new Error('Request cancelled'))) as typeof fetch
    await expect(send(fetchFn, 'https://provider.test', {})).rejects.toThrow(/timed out/)
  })

  it('fails fast without issuing the request once the gate fired', async () => {
    let called = false
    const fetchFn = (() => {
      called = true
      return Promise.resolve(new Response('ok'))
    }) as typeof fetch
    await expect(
      send(fetchFn, 'https://provider.test', {}, { isStale: () => true }),
    ).rejects.toThrow(/session ended/)
    expect(called).toBe(false)
  })
})
