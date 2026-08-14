import { simulateReadableStream } from 'ai'
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'

/**
 * The App Review demo key. App Store reviewers have no BYOK key, so this
 * sentinel (shared with Apple in the App Review notes; not a secret) makes
 * the app behave as if a real key was entered while never touching the
 * network.
 */
export const APP_REVIEW_STUB_KEY = 'sk-demo'

export function stubTranscriptBody(): string {
  return (
    "This is a demo transcription produced by Reflect's App Review demo key. " +
    'No audio left the device and no AI provider was called.\n\n' +
    `Demo transcript generated at ${new Date().toLocaleString()}.`
  )
}

/** The canned reply every LLM surface streams in demo mode. */
export const DEMO_REPLY_TEXT =
  "This is Reflect's App Review demo mode. This reply was generated locally and nothing left the device. " +
  'With a real API key, Reflect answers from your own notes, and notes marked private never leave the device.'

const DEMO_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

/**
 * A local `LanguageModelV3` that streams {@link DEMO_REPLY_TEXT}: what every
 * LLM call site gets when the configured key is {@link APP_REVIEW_STUB_KEY}.
 */
export function createDemoModel(): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'reflect-demo',
    modelId: 'reflect-demo',
    supportedUrls: {},
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: DEMO_REPLY_TEXT }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: DEMO_USAGE,
        warnings: [],
      }),
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream<LanguageModelV3StreamPart>({
          chunkDelayInMs: 10,
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'demo-reply' },
            ...DEMO_REPLY_TEXT.split(/(?<=\s)/).map(
              (delta): LanguageModelV3StreamPart => ({
                type: 'text-delta',
                id: 'demo-reply',
                delta,
              }),
            ),
            { type: 'text-end', id: 'demo-reply' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: DEMO_USAGE,
            },
          ],
        }),
      }),
  }
}
