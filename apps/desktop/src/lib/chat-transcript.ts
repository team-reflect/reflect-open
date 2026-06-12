import type {
  ChatModelMessage,
  ChatStreamEvent,
  NoteToolCall,
  NoteToolResult,
} from '@reflect/core'

/**
 * The chat view's conversation model (Plan 10). A {@link ChatTurn} is the
 * single source of truth for one exchange: the user's text, the assistant's
 * renderable parts, and the model-facing messages the turn contributed. The
 * provider stores only turns — the history a new turn resends is *derived*
 * via {@link buildHistory}, so the transcript and the model's view can never
 * drift apart.
 *
 * Parts are built by folding the engine's {@link ChatStreamEvent}s with
 * {@link appendEvent} (pure, so the fold is unit-testable without
 * streaming). Tool parts are generic — only the chip that renders them
 * switches on which tool it was.
 */

/** One renderable slice of an assistant message. */
export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: NoteToolCall; result: NoteToolResult | null; error: string | null }
  | { kind: 'notice'; tone: 'error' | 'info'; text: string }

/** One user message and everything the assistant did in response. */
export interface ChatTurn {
  id: string
  userText: string
  parts: AssistantPart[]
  /** The model-facing messages this turn contributed once it settled. */
  responseMessages: ChatModelMessage[]
  status: 'streaming' | 'done'
}

/** Whether a tool part is still awaiting its outcome. */
export function isToolPending(part: Extract<AssistantPart, { kind: 'tool' }>): boolean {
  return part.result === null && part.error === null
}

/** Fold one stream event into an assistant message's parts (immutable). */
export function appendEvent(parts: AssistantPart[], event: ChatStreamEvent): AssistantPart[] {
  switch (event.type) {
    case 'text-delta': {
      const last = parts.at(-1)
      if (last?.kind === 'text') {
        return [...parts.slice(0, -1), { kind: 'text', text: last.text + event.text }]
      }
      return [...parts, { kind: 'text', text: event.text }]
    }
    case 'tool-call':
      return [...parts, { kind: 'tool', call: event.call, result: null, error: null }]
    case 'tool-result':
      return parts.map((part) =>
        part.kind === 'tool' && part.call.toolCallId === event.result.toolCallId
          ? { ...part, result: event.result }
          : part,
      )
    case 'tool-error':
      return [
        ...parts.map((part): AssistantPart =>
          part.kind === 'tool' && part.call.toolCallId === event.toolCallId && isToolPending(part)
            ? { ...part, error: event.message }
            : part,
        ),
        { kind: 'notice', tone: 'error', text: event.message },
      ]
    case 'error':
      return [...parts, { kind: 'notice', tone: 'error', text: event.message }]
    case 'aborted':
      return [...parts, { kind: 'notice', tone: 'info', text: 'Stopped.' }]
    case 'complete':
      return parts
  }
}

/**
 * The model-facing history a new turn resends: every user message followed
 * by the messages its turn contributed (tool calls and results included —
 * settled turns carry them even when stopped or failed part-way).
 */
export function buildHistory(turns: readonly ChatTurn[]): ChatModelMessage[] {
  return turns.flatMap((turn): ChatModelMessage[] => [
    { role: 'user', content: turn.userText },
    ...turn.responseMessages,
  ])
}
