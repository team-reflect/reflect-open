import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
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

const OPENROUTER_CONFIG: AiProviderConfig = {
  id: 'cfg-openrouter',
  provider: 'openrouter',
  model: 'openrouter/auto',
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

function recordingOpenRouterFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
    })
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_123',
        object: 'chat.completion',
        created: 0,
        model: OPENROUTER_CONFIG.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

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

  it('routes OpenRouter through its OpenAI-compatible chat endpoint', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(OPENROUTER_CONFIG, 'sk-or-v1-test', recordingOpenRouterFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-or-v1-test')
    expect(calls[0]!.headers.get('HTTP-Referer')).toBe('https://reflect.app')
    expect(calls[0]!.headers.get('X-OpenRouter-Title')).toBe('Reflect')
  })
})
