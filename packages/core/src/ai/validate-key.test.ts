import { describe, expect, it } from 'vitest'
import { validateApiKey } from './validate-key'

function fetchReturning(status: number): typeof fetch {
  return async () => new Response(null, { status })
}

const fetchThrowing: typeof fetch = async () => {
  throw new TypeError('network down')
}

describe('validateApiKey', () => {
  it('sends the provider-specific auth headers to the model-listing endpoint', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const recordingFetch: typeof fetch = async (input, init) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      })
      return new Response(null, { status: 200 })
    }

    await validateApiKey('openai', 'sk-test', recordingFetch)
    await validateApiKey('anthropic', 'sk-ant-test', recordingFetch)
    await validateApiKey('google', 'AIza-test', recordingFetch)
    await validateApiKey('openrouter', 'sk-or-v1-test', recordingFetch)

    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models')
    expect(calls[0]!.headers['Authorization']).toBe('Bearer sk-test')
    expect(calls[1]!.url).toBe('https://api.anthropic.com/v1/models')
    expect(calls[1]!.headers['x-api-key']).toBe('sk-ant-test')
    expect(calls[1]!.headers['anthropic-version']).toBe('2023-06-01')
    expect(calls[2]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(calls[2]!.headers['x-goog-api-key']).toBe('AIza-test')
    expect(calls[3]!.url).toBe('https://openrouter.ai/api/v1/key')
    expect(calls[3]!.headers['Authorization']).toBe('Bearer sk-or-v1-test')
  })

  it('reads an ok response as valid', async () => {
    expect(await validateApiKey('openai', 'sk-test', fetchReturning(200))).toBe('valid')
  })

  it('reads an auth rejection as invalid', async () => {
    expect(await validateApiKey('openai', 'sk-test', fetchReturning(401))).toBe('invalid')
    expect(await validateApiKey('anthropic', 'sk-test', fetchReturning(403))).toBe('invalid')
    // Gemini reports malformed keys as 400.
    expect(await validateApiKey('google', 'bad', fetchReturning(400))).toBe('invalid')
    expect(await validateApiKey('openrouter', 'sk-or-v1-test', fetchReturning(401))).toBe(
      'invalid',
    )
  })

  it('reads anything that is not an auth decision as unreachable', async () => {
    expect(await validateApiKey('openai', 'sk-test', fetchReturning(500))).toBe('unreachable')
    expect(await validateApiKey('openai', 'sk-test', fetchReturning(429))).toBe('unreachable')
    expect(await validateApiKey('openai', 'sk-test', fetchThrowing)).toBe('unreachable')
  })
})
