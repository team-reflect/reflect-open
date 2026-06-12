import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { errorMessage } from '../../errors'
import type { AiModelConfig } from '../../settings/schema'
import { chatSystemPrompt } from './system-prompt'
import { buildNoteTools, type NoteToolDeps } from './tools'

/**
 * The streaming chat engine (Plan 10, read-only first wave): one BYOK call
 * direct from the app to the user's provider, grounded in local notes via the
 * read-only tools. The provider SDK's stream is normalized into a small typed
 * event union so the UI renders text, tool activity, and errors from one
 * shape regardless of provider.
 */

/** Ceiling on model↔tool round-trips per user turn. */
const MAX_STEPS = 8

export interface StreamChatOptions {
  /** The configured model entry to call (provider + model id). */
  model: AiModelConfig
  /** The BYOK API key, read from the OS keychain by the caller. */
  apiKey: string
  /**
   * Transport for the provider call — the desktop passes its shell fetch
   * (CORS-free, host-allowlisted); tests pass a stub.
   */
  fetchFn: typeof fetch
  /** Full model-facing history including the new user message. */
  messages: ModelMessage[]
  /** Local ISO date for the system prompt (daily-note key space). */
  today: string
  /** Aborts the provider call mid-stream (the UI's stop button). */
  signal?: AbortSignal
  /** Test seam for the note tools' effects. */
  toolDeps?: NoteToolDeps
  /** Test seam: a concrete model instead of provider construction. */
  modelOverride?: LanguageModel
}

/** One normalized event in a chat turn's stream. */
export type ChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'search-call'; toolCallId: string; query: string }
  | { type: 'search-result'; toolCallId: string; query: string; hits: SearchEventHit[] }
  | { type: 'read-call'; toolCallId: string; path: string }
  | { type: 'read-result'; toolCallId: string; path: string; title: string | null; error: string | null }
  | { type: 'tool-error'; toolCallId: string; message: string }
  | { type: 'error'; message: string; messages: ModelMessage[] }
  | { type: 'aborted'; messages: ModelMessage[] }
  | { type: 'complete'; messages: ModelMessage[] }

/** The slice of a search hit the UI's activity chips render. */
export interface SearchEventHit {
  path: string
  title: string
}

function languageModel(config: AiModelConfig, apiKey: string, fetchFn: typeof fetch): LanguageModel {
  switch (config.provider) {
    case 'openai':
      return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
    case 'anthropic':
      return createAnthropic({ apiKey, fetch: fetchFn })(config.model)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, fetch: fetchFn })(config.model)
  }
}

/**
 * Run one chat turn, yielding normalized {@link ChatStreamEvent}s. The stream
 * terminates with exactly one of `complete`, `aborted`, or `error` — each
 * carrying the assistant/tool messages to append to the model history. For a
 * cut-short turn those are the completed steps' messages (kept properly
 * paired — a dangling tool call without its result would be rejected by
 * providers on the next turn) plus the interrupted step's partial text, so
 * the history the next turn resends matches what stayed on screen.
 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
  const tools = buildNoteTools(options.toolDeps)

  // Messages for all *completed* steps (cumulative, assistant/tool pairs)…
  let stepMessages: ModelMessage[] = []
  // …and the text streamed so far in the step still in flight.
  let pendingText = ''
  const partialMessages = (): ModelMessage[] =>
    pendingText === ''
      ? stepMessages
      : [...stepMessages, { role: 'assistant', content: pendingText }]

  try {
    const result = streamText({
      model: options.modelOverride ?? languageModel(options.model, options.apiKey, options.fetchFn),
      system: chatSystemPrompt({ today: options.today }),
      messages: options.messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: options.signal,
      onStepFinish: (step) => {
        stepMessages = [...step.response.messages]
      },
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          pendingText += part.text
          yield { type: 'text-delta', text: part.text }
          break
        case 'finish-step':
          // onStepFinish has already folded this step's text into
          // stepMessages; only unfinished-step text may count as partial.
          pendingText = ''
          break
        case 'tool-call':
          if (part.dynamic) {
            break
          }
          if (part.toolName === 'search_notes') {
            yield { type: 'search-call', toolCallId: part.toolCallId, query: part.input.query }
          } else {
            yield { type: 'read-call', toolCallId: part.toolCallId, path: part.input.path }
          }
          break
        case 'tool-result':
          if (part.dynamic) {
            break
          }
          if (part.toolName === 'search_notes') {
            yield {
              type: 'search-result',
              toolCallId: part.toolCallId,
              query: part.input.query,
              hits: part.output.hits.map((hit) => ({ path: hit.path, title: hit.title })),
            }
          } else {
            yield {
              type: 'read-result',
              toolCallId: part.toolCallId,
              path: part.output.path,
              title: part.output.title,
              error: part.output.error,
            }
          }
          break
        case 'tool-error':
          yield { type: 'tool-error', toolCallId: part.toolCallId, message: errorMessage(part.error) }
          break
        case 'abort':
          yield { type: 'aborted', messages: partialMessages() }
          return
        case 'error':
          yield { type: 'error', message: errorMessage(part.error), messages: partialMessages() }
          return
        default:
          break
      }
    }

    const response = await result.response
    yield { type: 'complete', messages: response.messages }
  } catch (cause) {
    // Belt and braces: most failures surface as `error` parts above, but a
    // synchronous throw (bad config, aborted before first byte) lands here.
    if (options.signal?.aborted === true) {
      yield { type: 'aborted', messages: partialMessages() }
      return
    }
    yield { type: 'error', message: errorMessage(cause), messages: partialMessages() }
  }
}
