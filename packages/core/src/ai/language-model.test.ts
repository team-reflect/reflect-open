import { generateText } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import {
  ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER,
  ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE,
} from './anthropic-headers'
import { languageModel } from './language-model'

interface RecordedCall {
  readonly url: string
  readonly headers: Headers
}

const ANTHROPIC_CONFIG: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  keyHint: 'wxyz1',
}

function recordingAnthropicFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
    })
    return new Response(
      JSON.stringify({
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: ANTHROPIC_CONFIG.model,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('languageModel', () => {
  it('adds Anthropic direct-browser access to model calls', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(ANTHROPIC_CONFIG, 'sk-ant-test', recordingAnthropicFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.headers.get(ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER)).toBe(
      ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE,
    )
  })

  it('ignores ambient *_BASE_URL environment variables', async () => {
    // The SDK factories read these when no baseURL is passed — a stray
    // variable in whatever shell launched the app (Claude Code exports
    // ANTHROPIC_BASE_URL, for one) must not reroute BYOK traffic.
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://reroute.example')
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(ANTHROPIC_CONFIG, 'sk-ant-test', recordingAnthropicFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
  })
})
