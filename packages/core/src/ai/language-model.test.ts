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
  readonly body: string | null
}

const ANTHROPIC_CONFIG: AiProviderConfig = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  keyHint: 'wxyz1',
}

const OPENAI_CONFIG: AiProviderConfig = {
  id: 'cfg-openai',
  provider: 'openai',
  model: 'gpt-5.6-terra',
  keyHint: 'wxyz1',
}

const OPENROUTER_CONFIG: AiProviderConfig = {
  id: 'cfg-openrouter',
  provider: 'openrouter',
  model: 'openrouter/auto',
  keyHint: 'wxyz1',
}

const OPENAI_COMPATIBLE_CONFIG: AiProviderConfig = {
  id: 'cfg-local',
  provider: 'openai-compatible',
  model: 'llama-local',
  baseUrl: 'http://localhost:1234/v1',
  keyHint: '',
}

function recordingAnthropicFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
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

function recordingOpenAiFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'resp_123',
        created_at: 0,
        model: OPENAI_CONFIG.model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            id: 'msg_123',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
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
      body: typeof init?.body === 'string' ? init.body : null,
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

function recordingOpenAICompatibleFetch(calls: RecordedCall[]): typeof fetch {
  return async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return new Response(
      JSON.stringify({
        id: 'chatcmpl_local',
        object: 'chat.completion',
        created: 0,
        model: OPENAI_COMPATIBLE_CONFIG.model,
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
  it('routes a GPT-5.6 model through OpenAI Responses', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(OPENAI_CONFIG, 'sk-test', recordingOpenAiFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(calls[0]!.headers.get('Authorization')).toBe('Bearer sk-test')
    expect(calls[0]!.body).toContain('"model":"gpt-5.6-terra"')
  })

  it('routes Claude Sonnet 5 through Anthropic Messages with direct-browser access', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(ANTHROPIC_CONFIG, 'sk-ant-test', recordingAnthropicFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]!.body).toContain('"model":"claude-sonnet-5"')
    expect(calls[0]!.body).toContain('"max_tokens":128000')
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

  it('routes custom OpenAI-compatible providers through their configured endpoint', async () => {
    const calls: RecordedCall[] = []

    await generateText({
      model: languageModel(OPENAI_COMPATIBLE_CONFIG, '', recordingOpenAICompatibleFetch(calls)),
      prompt: 'hello',
      maxRetries: 0,
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://localhost:1234/v1/chat/completions')
    expect(calls[0]!.headers.get('Authorization')).toBeNull()
  })
})
