import { isStepCount, streamText, type LanguageModel, type ModelMessage } from 'ai'
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
import type { ChatNoteToolHost } from './note-mutations'
import type { ChatPermissionMode } from './permissions'
import type { ChatSourceRef } from './transcript'

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

const SOURCE_REVALIDATION_ERROR =
  'A note source is no longer available to AI. The turn stopped before sending another request.'

export interface StreamChatOptions {
  /** The provider entry to call, with `model` set to the model id to use. */
  config: AiProviderConfig
  /** The BYOK API key, or an empty string for no-key compatible endpoints. */
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
  /** Whether note search can use embeddings for meaning-based recall. */
  semanticSearchEnabled: boolean
  /** User-authored instructions appended to Reflect's built-in system prompt. */
  customSystemPrompt: string
  /**
   * Graph overview for the system prompt (`loadChatGraphContext`), or
   * `null` to send the prompt without it — required so call sites decide
   * the degraded mode explicitly rather than forgetting the block.
   */
  context: CloudSafe<CloudGraphContext> | null
  /** Aborts the provider call mid-stream (the UI's stop button). */
  signal?: AbortSignal
  /** Capability captured when the user sent this turn. */
  permissionMode?: ChatPermissionMode
  /** Live note host; mutation tools require it in Read & write mode. */
  noteHost?: ChatNoteToolHost
  /**
   * Rebuild the provider-safe initial messages immediately before every model
   * step. The result includes the current user message; contaminated history
   * suffixes must already be omitted, and history excluded before the turn
   * must never be added back. A shorter result is safe on the first step; if
   * it changes after a model response exists, the turn stops instead of
   * replaying that response on a different provenance base.
   */
  revalidateHistory: () => Promise<ModelMessage[]>
  /** Revalidate one current-turn tool source against the freshest live graph state. */
  validateSource: (source: ChatSourceRef) => Promise<boolean>
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
  const contextWindowOptions = {
    contextWindow: modelContextWindow(options.config.provider, options.config.model),
    systemPrompt: chatSystemPrompt({
      today: options.today,
      context: options.context,
      semanticSearchEnabled: options.semanticSearchEnabled,
      customSystemPrompt: options.customSystemPrompt,
      permissionMode: options.permissionMode ?? 'read',
    }),
  }
  const fitMessages = (messages: ModelMessage[]): ModelMessage[] =>
    fitToContextWindow(messages, contextWindowOptions)
  const messages = fitMessages(options.messages)
  return streamChatTurn(languageModel(options.config, options.apiKey, options.fetchFn), {
    messages,
    today: options.today,
    semanticSearchEnabled: options.semanticSearchEnabled,
    customSystemPrompt: options.customSystemPrompt,
    context: options.context,
    signal: options.signal,
    permissionMode: options.permissionMode ?? 'read',
    noteHost: options.noteHost,
    revalidateHistory: async () => fitMessages(await options.revalidateHistory()),
    validateSource: options.validateSource,
  })
}

/** {@link streamChatTurn}'s options: {@link StreamChatOptions} minus provider wiring. */
export interface ChatTurnOptions {
  /** Full model-facing history including the new user message. */
  messages: ModelMessage[]
  /** Local ISO date for the system prompt (daily-note key space). */
  today: string
  /** Whether note search can use embeddings for meaning-based recall. */
  semanticSearchEnabled: boolean
  /** User-authored instructions appended to Reflect's built-in system prompt. */
  customSystemPrompt: string
  /** Graph overview for the system prompt, or `null` to omit the block. */
  context: CloudSafe<CloudGraphContext> | null
  /** Aborts the provider call mid-stream (the UI's stop button). */
  signal?: AbortSignal | undefined
  /** Test seam for the note tools' effects. */
  toolDeps?: NoteToolDeps | undefined
  /** Capability captured when the user sent this turn. */
  permissionMode?: ChatPermissionMode | undefined
  /** Live note host; mutation tools require it in Read & write mode. */
  noteHost?: ChatNoteToolHost | undefined
  /** Provider-safe initial messages, rebuilt before every model step. */
  revalidateHistory: () => Promise<ModelMessage[]>
  /** Fresh live eligibility check for a current-turn tool source. */
  validateSource: (source: ChatSourceRef) => Promise<boolean>
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
  const observedSources = new Map<string, ChatSourceRef>()
  const tools = buildNoteTools({
    ...options.toolDeps,
    semanticSearchEnabled: options.semanticSearchEnabled,
    permissionMode: options.permissionMode ?? 'read',
    ...(options.noteHost === undefined ? {} : { noteHost: options.noteHost }),
    observeSource: (source) => observedSources.set(`${source.kind}:${source.path}`, source),
  })

  // Messages for all *completed* steps (cumulative, assistant/tool pairs)…
  let stepMessages: ModelMessage[] = []
  // …and the text streamed so far in the step still in flight.
  let pendingText = ''
  const partialMessages = (): ModelMessage[] =>
    pendingText === ''
      ? stepMessages
      : [...stepMessages, { role: 'assistant', content: pendingText }]
  // Freeze the exact provider-facing history established by the first step.
  // Comparing only its length is insufficient after context fitting: removing
  // a newly-private suffix can pull older, previously-trimmed turns into the
  // same number of message slots. Replaying completed step messages on that
  // different base could resend text derived from the now-private history.
  let firstStepInitialMessagesFingerprint: string | null = null

  try {
    const result = streamText({
      model,
      instructions: chatSystemPrompt({
        today: options.today,
        context: options.context,
        semanticSearchEnabled: options.semanticSearchEnabled,
        customSystemPrompt: options.customSystemPrompt,
        permissionMode: options.permissionMode ?? 'read',
      }),
      messages: options.messages,
      tools,
      stopWhen: isStepCount(MAX_STEPS),
      // On the final permitted step, disable tools so the model must answer
      // from what it has already gathered. Without this a turn still calling
      // tools when the ceiling fires ends on a tool result with no reply — the
      // user sees tool activity, then silence. `stepNumber` counts completed
      // steps, so the last step that runs is `MAX_STEPS - 1`.
      prepareStep: async ({ stepNumber, responseMessages }) => {
        try {
          const [revalidatedInitialMessages, ...sourceVerdicts] = await Promise.all([
            options.revalidateHistory(),
            ...[...observedSources.values()].map(
              async (source) => await options.validateSource(source),
            ),
          ])
          if (sourceVerdicts.some((allowed) => !allowed)) {
            throw new Error(SOURCE_REVALIDATION_ERROR)
          }
          const historyFingerprint = JSON.stringify(revalidatedInitialMessages)
          if (
            firstStepInitialMessagesFingerprint !== null &&
            historyFingerprint !== firstStepInitialMessagesFingerprint
          ) {
            throw new Error(SOURCE_REVALIDATION_ERROR)
          }
          firstStepInitialMessagesFingerprint ??= historyFingerprint
          return {
            messages: [...revalidatedInitialMessages, ...responseMessages],
            ...(stepNumber >= MAX_STEPS - 1 ? { toolChoice: 'none' as const } : {}),
          }
        } catch {
          throw new Error(SOURCE_REVALIDATION_ERROR)
        }
      },
      onError: () => undefined,
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
      // `step.response.messages` holds only the messages that step created,
      // so the running history is accumulated here rather than assigned.
      onStepEnd: (step) => {
        stepMessages = [...stepMessages, ...step.response.messages]
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
          const toolResult = noteToolResult(part, [...observedSources.values()])
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
