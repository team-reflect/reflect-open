import { stepCountIs, streamText, type LanguageModel, type ModelMessage } from 'ai'
import { errorMessage } from '../../errors'
import { languageModel } from '../language-model'
import { modelContextWindow } from '../provider-catalog'
import type { AiProviderConfig } from '../../settings/schema'
import type { CloudGraphContext, CloudSafe } from '../checkers'
import { fitToContextWindow } from './context-window'
import { chatSystemPrompt } from './system-prompt'
import {
  buildNoteTools,
  noteToolCall,
  noteToolResult,
  type NoteToolCall,
  type NoteToolDeps,
  type NoteToolResult,
} from './tools'

/**
 * The streaming chat engine (Plan 10, read-only first wave): one BYOK call
 * direct from the app to the user's provider, grounded in local notes via the
 * read-only tools. The provider SDK's stream is normalized into a small typed
 * event union so the UI renders text, tool activity, and errors from one
 * shape regardless of provider. Tool payloads stay opaque here — their
 * shapes (and the only code that knows tool names) live in `./tools`.
 */

/**
 * Ceiling on model↔tool round-trips per user turn. The model batches several
 * tool calls into each step, so this is generous headroom for multi-note
 * gathering rather than a tight budget — and the `prepareStep` hook below
 * guarantees the turn still ends with a reply when the ceiling is reached
 * mid-gather (see {@link streamChatTurn}).
 */
export const MAX_STEPS = 12

export interface StreamChatOptions {
  /** The provider entry to call, with `model` set to the model id to use. */
  config: AiProviderConfig
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
  /**
   * Graph overview for the system prompt (`loadChatGraphContext`), or
   * `null` to send the prompt without it — required so call sites decide
   * the degraded mode explicitly rather than forgetting the block.
   */
  context: CloudSafe<CloudGraphContext> | null
  /** Aborts the provider call mid-stream (the UI's stop button). */
  signal?: AbortSignal
}

/** One normalized event in a chat turn's stream. */
export type ChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: NoteToolCall }
  | { type: 'tool-result'; result: NoteToolResult }
  | { type: 'tool-error'; toolCallId: string; message: string }
  | { type: 'error'; message: string; messages: ModelMessage[] }
  | { type: 'aborted'; messages: ModelMessage[] }
  | { type: 'complete'; messages: ModelMessage[] }

/**
 * Run one chat turn against the user's configured provider, yielding
 * normalized {@link ChatStreamEvent}s. The history is first fitted to the
 * model's context budget ({@link fitToContextWindow}) — a long conversation
 * trims its oldest turns here rather than erroring at the provider. See
 * {@link streamChatTurn} for the stream's contract.
 */
export function streamChat(options: StreamChatOptions): AsyncGenerator<ChatStreamEvent> {
  const messages = fitToContextWindow(options.messages, {
    contextWindow: modelContextWindow(options.config.provider, options.config.model),
    systemPrompt: chatSystemPrompt({ today: options.today, context: options.context }),
  })
  return streamChatTurn(languageModel(options.config, options.apiKey, options.fetchFn), {
    messages,
    today: options.today,
    context: options.context,
    signal: options.signal,
  })
}

/** {@link streamChatTurn}'s options: {@link StreamChatOptions} minus provider wiring. */
export interface ChatTurnOptions {
  /** Full model-facing history including the new user message. */
  messages: ModelMessage[]
  /** Local ISO date for the system prompt (daily-note key space). */
  today: string
  /** Graph overview for the system prompt, or `null` to omit the block. */
  context: CloudSafe<CloudGraphContext> | null
  /** Aborts the provider call mid-stream (the UI's stop button). */
  signal?: AbortSignal | undefined
  /** Test seam for the note tools' effects. */
  toolDeps?: NoteToolDeps | undefined
}

/**
 * The engine under {@link streamChat}, taking a concrete model — the seam
 * tests drive with a mock model instead of a provider. The stream terminates
 * with exactly one of `complete`, `aborted`, or `error` — each carrying the
 * assistant/tool messages to append to the model history. For a cut-short
 * turn those are the completed steps' messages (kept properly paired — a
 * dangling tool call without its result would be rejected by providers on
 * the next turn) plus the interrupted step's partial text, so the history
 * the next turn resends matches what stayed on screen.
 */
export async function* streamChatTurn(
  model: LanguageModel,
  options: ChatTurnOptions,
): AsyncGenerator<ChatStreamEvent> {
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
      model,
      system: chatSystemPrompt({ today: options.today, context: options.context }),
      messages: options.messages,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      // On the final permitted step, disable tools so the model must answer
      // from what it has already gathered. Without this a turn still calling
      // tools when the ceiling fires ends on a tool result with no reply — the
      // user sees tool activity, then silence. `stepNumber` counts completed
      // steps, so the last step that runs is `MAX_STEPS - 1`.
      prepareStep: ({ stepNumber }) =>
        stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' } : {},
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
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
        case 'tool-call': {
          const call = noteToolCall(part)
          if (call) {
            yield { type: 'tool-call', call }
          }
          break
        }
        case 'tool-result': {
          const toolResult = noteToolResult(part)
          if (toolResult) {
            yield { type: 'tool-result', result: toolResult }
          }
          break
        }
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
