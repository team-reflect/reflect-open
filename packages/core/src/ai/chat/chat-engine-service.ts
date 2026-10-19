import type { LanguageModel, ModelMessage } from '@reflect/modules/ai'
import { errorMessage } from '../../errors.ts'
import type { LoggerService } from '../../ports/logger-service.ts'
import type { CloudGraphContext, CloudSafe } from '../../privacy/privacy-service.ts'
import type { AiProviderConfig } from '../../settings/schema.ts'
import type { LanguageModelService } from '../language-model-service.ts'
import { modelContextWindow } from '../provider-catalog.ts'
import type { ContextWindowOptions } from './context-window.ts'
import {
  noteToolCall,
  noteToolResult,
  type NoteToolCall,
  type NoteToolResult,
  type NoteTools,
  type NoteToolsService,
} from './note-tools-service.ts'
import { chatSystemPrompt } from './system-prompt.ts'

/**
 * The streaming chat engine (Plan 10, read-only first wave): one BYOK call
 * direct from the app to the user's provider, grounded in local notes via the
 * read-only tools. The provider SDK's stream is normalized into a small typed
 * event union so the UI renders text, tool activity, and errors from one
 * shape regardless of provider. Tool payloads stay opaque here — their
 * shapes (and the only code that knows tool names) live in
 * `./note-tools-service`.
 */

/**
 * Ceiling on model↔tool round-trips per user turn. The model batches several
 * tool calls into each step, so this is generous headroom for multi-note
 * gathering rather than a tight budget — and the `prepareStep` hook below
 * guarantees the turn still ends with a reply when the ceiling is reached
 * mid-gather (see {@link streamChatTurn}).
 */
export const MAX_STEPS = 12

/**
 * One chat turn for {@link ChatEngineService.streamTurn}.
 */
export interface ChatTurnRequest {
  /**
   * The provider entry to call, with `model` set to the model id to use.
   */
  config: AiProviderConfig
  /**
   * The BYOK API key, or an empty string for no-key compatible endpoints.
   */
  apiKey: string
  /**
   * Full model-facing history including the new user message.
   */
  messages: ModelMessage[]
  /**
   * Local ISO date for the system prompt (daily-note key space).
   */
  today: string
  /**
   * Whether note search can use embeddings for meaning-based recall.
   */
  semanticSearchEnabled: boolean
  /**
   * The file generation of the graph session the turn runs in; note tools read at it.
   */
  generation: number
  /**
   * User-authored instructions appended to Reflect's built-in system prompt.
   */
  customSystemPrompt: string
  /**
   * Graph overview for the system prompt (`ChatGraphContextService.load`), or
   * `null` to send the prompt without it — required so call sites decide
   * the degraded mode explicitly rather than forgetting the block.
   */
  context: CloudSafe<CloudGraphContext> | null
  /**
   * Aborts the provider call mid-stream (the UI's stop button).
   */
  signal?: AbortSignal
}

/**
 * One normalized event in a chat turn's stream.
 */
export type ChatStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: NoteToolCall }
  | { type: 'tool-result'; result: NoteToolResult }
  | { type: 'tool-error'; toolCallId: string; message: string }
  | { type: 'error'; message: string; messages: ModelMessage[] }
  | { type: 'aborted'; messages: ModelMessage[] }
  | { type: 'complete'; messages: ModelMessage[] }

/**
 * Fits a model-facing history into a context budget; see `fitToContextWindow`.
 */
export type FitToContextWindow = (
  messages: ModelMessage[],
  options: ContextWindowOptions,
) => ModelMessage[]

export interface ChatEngineServiceDeps {
  readonly logger: LoggerService
  readonly languageModel: LanguageModelService
  readonly noteTools: NoteToolsService
  readonly fitToContextWindow: FitToContextWindow
}

/**
 * Runs tool-grounded chat turns against the user's provider.
 */
export interface ChatEngineService {
  /**
   * Run one chat turn against the user's configured provider, yielding
   * normalized {@link ChatStreamEvent}s. The history is first fitted to the
   * model's context budget — a long conversation trims its oldest turns here
   * rather than erroring at the provider. See {@link streamChatTurn} for the
   * stream's contract.
   */
  streamTurn(request: ChatTurnRequest): AsyncGenerator<ChatStreamEvent>
}

class ChatEngineServiceImpl implements ChatEngineService {
  readonly #deps: ChatEngineServiceDeps

  constructor(deps: ChatEngineServiceDeps) {
    this.#deps = deps
  }

  async *streamTurn(request: ChatTurnRequest): AsyncGenerator<ChatStreamEvent> {
    const { logger, languageModel, noteTools, fitToContextWindow } = this.#deps
    try {
      request.signal?.throwIfAborted()
      const messages = fitToContextWindow(request.messages, {
        contextWindow: modelContextWindow(request.config.provider, request.config.model),
        systemPrompt: chatSystemPrompt({
          today: request.today,
          context: request.context,
          semanticSearchEnabled: request.semanticSearchEnabled,
          customSystemPrompt: request.customSystemPrompt,
        }),
      })
      const model = await languageModel.create(request.config, request.apiKey)
      request.signal?.throwIfAborted()
      yield* streamChatTurn({ logger }, model, {
        messages,
        today: request.today,
        semanticSearchEnabled: request.semanticSearchEnabled,
        customSystemPrompt: request.customSystemPrompt,
        context: request.context,
        signal: request.signal,
        tools: noteTools.build({
          semanticSearchEnabled: request.semanticSearchEnabled,
          generation: request.generation,
        }),
      })
    } catch (cause) {
      yield request.signal?.aborted
        ? { type: 'aborted', messages: [] }
        : { type: 'error', message: errorMessage(cause), messages: [] }
    }
  }
}

export function createChatEngineService(deps: ChatEngineServiceDeps): ChatEngineService {
  return new ChatEngineServiceImpl(deps)
}

/**
 * {@link streamChatTurn}'s options: {@link ChatTurnRequest} minus provider wiring, plus the tools.
 */
export interface ChatTurnOptions {
  /**
   * Full model-facing history including the new user message.
   */
  messages: ModelMessage[]
  /**
   * Local ISO date for the system prompt (daily-note key space).
   */
  today: string
  /**
   * Whether note search can use embeddings for meaning-based recall.
   */
  semanticSearchEnabled: boolean
  /**
   * User-authored instructions appended to Reflect's built-in system prompt.
   */
  customSystemPrompt: string
  /**
   * Graph overview for the system prompt, or `null` to omit the block.
   */
  context: CloudSafe<CloudGraphContext> | null
  /**
   * Aborts the provider call mid-stream (the UI's stop button).
   */
  signal?: AbortSignal | undefined
  /**
   * The tools the model can call (`NoteToolsService.build`).
   */
  tools: NoteTools
}

/**
 * The engine under {@link ChatEngineService.streamTurn}, taking a concrete model — the seam
 * tests drive with a mock model instead of a provider. The stream terminates
 * with exactly one of `complete`, `aborted`, or `error` — each carrying the
 * assistant/tool messages to append to the model history. For a cut-short
 * turn those are the completed steps' messages (kept properly paired — a
 * dangling tool call without its result would be rejected by providers on
 * the next turn) plus the interrupted step's partial text, so the history
 * the next turn resends matches what stayed on screen.
 */
export async function* streamChatTurn(
  ctx: { logger: LoggerService },
  model: LanguageModel,
  options: ChatTurnOptions,
): AsyncGenerator<ChatStreamEvent> {
  // Messages for all *completed* steps (cumulative, assistant/tool pairs)…
  let stepMessages: ModelMessage[] = []
  // …and the text streamed so far in the step still in flight.
  let pendingText = ''
  const partialMessages = (): ModelMessage[] => {
    return pendingText === ''
      ? stepMessages
      : [...stepMessages, { role: 'assistant', content: pendingText }]
  }

  try {
    const { isStepCount, streamText } = await import('@reflect/modules/ai')
    options.signal?.throwIfAborted()
    const result = streamText({
      model,
      instructions: chatSystemPrompt({
        today: options.today,
        context: options.context,
        semanticSearchEnabled: options.semanticSearchEnabled,
        customSystemPrompt: options.customSystemPrompt,
      }),
      messages: options.messages,
      tools: options.tools,
      stopWhen: isStepCount(MAX_STEPS),
      // On the final permitted step, disable tools so the model must answer
      // from what it has already gathered. Without this a turn still calling
      // tools when the ceiling fires ends on a tool result with no reply — the
      // user sees tool activity, then silence. `stepNumber` counts completed
      // steps, so the last step that runs is `MAX_STEPS - 1`.
      prepareStep: ({ stepNumber }) => (stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' } : {}),
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
      // `step.response.messages` holds only the messages that step created,
      // so the running history is accumulated here rather than assigned.
      onStepEnd: (step) => {
        stepMessages = [...stepMessages, ...step.response.messages]
      },
      // Without a handler the SDK prints the error to the console itself. The
      // error also arrives as an `error` part below.
      onError: ({ error }) => {
        ctx.logger.error('chat stream failed:', error)
      },
    })

    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          pendingText += part.text
          yield { type: 'text-delta', text: part.text }
          break
        case 'finish-step':
          // onStepEnd has already folded this step's text into
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
          yield {
            type: 'tool-error',
            toolCallId: part.toolCallId,
            message: errorMessage(part.error),
          }
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

    yield { type: 'complete', messages: await result.responseMessages }
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
