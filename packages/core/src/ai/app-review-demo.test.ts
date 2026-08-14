import { generateText, streamText } from 'ai'
import { describe, expect, it } from 'vitest'
import type { AiProviderConfig } from '../settings/schema'
import { APP_REVIEW_STUB_KEY, createDemoModel, DEMO_REPLY_TEXT } from './app-review-demo'
import { streamChat, type ChatStreamEvent } from './chat/stream-chat'

const throwingFetch = (() => {
  throw new Error('demo mode must not fetch')
}) as unknown as typeof fetch

describe('createDemoModel', () => {
  it('generates the demo reply without any transport', async () => {
    const result = await generateText({
      model: createDemoModel(),
      prompt: 'hello',
      maxRetries: 0,
    })
    expect(result.text).toBe(DEMO_REPLY_TEXT)
  })

  it('streams the demo reply word by word', async () => {
    const result = streamText({
      model: createDemoModel(),
      prompt: 'hello',
      maxRetries: 0,
    })
    let text = ''
    for await (const delta of result.textStream) {
      text += delta
    }
    expect(text).toBe(DEMO_REPLY_TEXT)
  })

  it('carries a full chat turn end to end without fetching', async () => {
    const config: AiProviderConfig = {
      id: 'cfg-demo',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      keyHint: 'demo1',
    }
    const events: ChatStreamEvent[] = []
    const turn = streamChat({
      config,
      apiKey: APP_REVIEW_STUB_KEY,
      fetchFn: throwingFetch,
      messages: [{ role: 'user', content: 'What is in my notes?' }],
      today: '2026-08-14',
      semanticSearchEnabled: false,
      customSystemPrompt: '',
      context: null,
    })
    for await (const event of turn) {
      events.push(event)
    }
    const text = events
      .flatMap((event) => (event.type === 'text-delta' ? [event.text] : []))
      .join('')
    expect(text).toBe(DEMO_REPLY_TEXT)
    expect(events.at(-1)?.type).toBe('complete')
  })
})
