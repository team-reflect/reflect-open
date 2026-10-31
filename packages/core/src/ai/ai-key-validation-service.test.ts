import { describe, expect, it } from 'vitest'
import { createTestHttpService } from '../testing/index.ts'
import { APP_REVIEW_STUB_KEY } from './app-review-demo.ts'
import {
  createAiKeyValidationService,
  type ApiKeyValidation,
  type ApiKeyValidationInput,
} from './ai-key-validation-service.ts'

async function validateApiKey(
  input: ApiKeyValidationInput,
  fetchFn: typeof fetch,
): Promise<ApiKeyValidation> {
  return await createAiKeyValidationService({ http: { fetch: fetchFn } }).validate(input)
}

function fetchReturning(status: number): typeof fetch {
  return () => Promise.resolve(new Response(null, { status }))
}

const fetchThrowing: typeof fetch = () => Promise.reject(new TypeError('network down'))

describe('AiKeyValidationService', () => {
  it('sends the provider-specific auth headers to the model-listing endpoint', async () => {
    const http = createTestHttpService()

    await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, http.fetchFn)
    await validateApiKey({ provider: 'anthropic', apiKey: 'sk-ant-test' }, http.fetchFn)
    await validateApiKey({ provider: 'google', apiKey: 'AIza-test' }, http.fetchFn)
    await validateApiKey({ provider: 'openrouter', apiKey: 'sk-or-v1-test' }, http.fetchFn)
    await validateApiKey(
      {
        provider: 'openai-compatible',
        apiKey: 'local-secret',
        baseUrl: 'http://localhost:1234/v1/',
      },
      http.fetchFn,
    )
    await validateApiKey(
      { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1' },
      http.fetchFn,
    )

    const calls = http.requests()
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-test')
    expect(calls[1]!.url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[1]!.headers.get('x-api-key')).toBe('sk-ant-test')
    expect(calls[1]!.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(calls[2]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(calls[2]!.headers.get('x-goog-api-key')).toBe('AIza-test')
    expect(calls[3]!.url).toBe('https://openrouter.ai/api/v1/key')
    expect(calls[3]!.headers.get('Authorization')).toBe('Bearer sk-or-v1-test')
    expect(calls[4]!.url).toBe('http://localhost:1234/v1/models')
    expect(calls[4]!.headers.get('Authorization')).toBe('Bearer local-secret')
    expect(calls[5]!.url).toBe('http://localhost:1234/v1/models')
    expect(calls[5]!.headers.get('Authorization')).toBeNull()
  })

  it('reads an ok response as valid', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(200)),
    ).toBe('valid')
  })

  it('accepts the App Review demo key without probing the provider', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: APP_REVIEW_STUB_KEY }, fetchThrowing),
    ).toBe('valid')
  })

  it('reads an auth rejection as invalid', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(401)),
    ).toBe('invalid')
    expect(
      await validateApiKey({ provider: 'anthropic', apiKey: 'sk-test' }, fetchReturning(403)),
    ).toBe('invalid')
    // Gemini reports malformed keys as 400.
    expect(await validateApiKey({ provider: 'google', apiKey: 'bad' }, fetchReturning(400))).toBe(
      'invalid',
    )
    expect(
      await validateApiKey(
        { provider: 'openrouter', apiKey: 'sk-or-v1-test' },
        fetchReturning(401),
      ),
    ).toBe('invalid')
    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'http://localhost:1234/v1' },
        fetchReturning(401),
      ),
    ).toBe('invalid')
  })

  it('reads anything that is not an auth decision as unreachable', async () => {
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(500)),
    ).toBe('unreachable')
    expect(
      await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchReturning(429)),
    ).toBe('unreachable')
    expect(await validateApiKey({ provider: 'openai', apiKey: 'sk-test' }, fetchThrowing)).toBe(
      'unreachable',
    )
  })

  it('reads an invalid OpenAI-compatible base URL as invalid without fetching', async () => {
    const http = createTestHttpService()
    expect(
      await validateApiKey(
        { provider: 'openai-compatible', apiKey: '', baseUrl: 'file:///tmp/model.sock' },
        http.fetchFn,
      ),
    ).toBe('invalid')
    expect(http.requests()).toEqual([])
  })
})
