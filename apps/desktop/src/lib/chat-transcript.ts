import type { ChatStreamEvent, SearchEventHit } from '@reflect/core'

/**
 * The chat view's transcript model (Plan 10): what one conversation renders.
 * An assistant message is an ordered list of parts — text interleaved with
 * the tool activity that produced it — built incrementally by folding the
 * engine's {@link ChatStreamEvent}s with {@link appendEvent} (pure, so the
 * fold is unit-testable without streaming).
 */

/** One renderable slice of an assistant message. */
export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'search'; toolCallId: string; query: string; hits: SearchEventHit[] | null }
  | {
      kind: 'read'
      toolCallId: string
      path: string
      title: string | null
      error: string | null
      pending: boolean
    }
  | { kind: 'notice'; tone: 'error' | 'info'; text: string }

export interface ChatUserMessage {
  id: string
  role: 'user'
  text: string
}

export interface ChatAssistantMessage {
  id: string
  role: 'assistant'
  parts: AssistantPart[]
}

export type ChatTranscriptMessage = ChatUserMessage | ChatAssistantMessage

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
    case 'search-call':
      return [
        ...parts,
        { kind: 'search', toolCallId: event.toolCallId, query: event.query, hits: null },
      ]
    case 'search-result':
      return parts.map((part) =>
        part.kind === 'search' && part.toolCallId === event.toolCallId
          ? { ...part, hits: event.hits }
          : part,
      )
    case 'read-call':
      return [
        ...parts,
        {
          kind: 'read',
          toolCallId: event.toolCallId,
          path: event.path,
          title: null,
          error: null,
          pending: true,
        },
      ]
    case 'read-result':
      return parts.map((part) =>
        part.kind === 'read' && part.toolCallId === event.toolCallId
          ? { ...part, title: event.title, error: event.error, pending: false }
          : part,
      )
    case 'tool-error':
      return [
        ...settleToolCall(parts, event.toolCallId, event.message),
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
 * A failed tool call must not keep rendering as in-flight — and a failed read
 * must not render as a clickable "Read …" success, so it keeps the failure.
 */
function settleToolCall(
  parts: AssistantPart[],
  toolCallId: string,
  message: string,
): AssistantPart[] {
  return parts.map((part) => {
    if (part.kind === 'search' && part.toolCallId === toolCallId && part.hits === null) {
      return { ...part, hits: [] }
    }
    if (part.kind === 'read' && part.toolCallId === toolCallId && part.pending) {
      return { ...part, pending: false, error: message }
    }
    return part
  })
}
