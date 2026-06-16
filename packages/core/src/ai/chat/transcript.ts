import type { ModelMessage } from 'ai'
import type { ChatStreamEvent } from './stream-chat'
import type { NoteToolCall, NoteToolResult } from './tools'

/**
 * The chat conversation model (Plan 10). A {@link ChatTurn} is the single
 * source of truth for one exchange: the user's text and image attachments,
 * the assistant's renderable parts, and the model-facing messages the turn
 * contributed. Hosts store only turns — the history a new turn resends is
 * *derived* via {@link buildHistory}, so the transcript and the model's view
 * can never drift apart. The same record is what the store persists
 * (`./store`), so a restored conversation renders and resends identically.
 *
 * Parts are built by folding the engine's {@link ChatStreamEvent}s with
 * {@link appendEvent} (pure, so the fold is unit-testable without
 * streaming). Tool parts are generic — only the chip that renders them
 * switches on which tool it was.
 */

/** One image the user attached to a chat turn. */
export interface ChatAttachment {
  id: string
  /** Original filename — the preview's alt text and accessible labels. */
  name: string
  /** IANA media type, e.g. `image/png`. */
  mediaType: string
  /** The image bytes as a `data:` URL — rendered as-is and sent to the provider. */
  dataUrl: string
}

/** One renderable slice of an assistant message. */
export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: NoteToolCall; result: NoteToolResult | null; error: string | null }
  | { kind: 'notice'; tone: 'error' | 'info'; text: string }

/** One user message and everything the assistant did in response. */
export interface ChatTurn {
  id: string
  userText: string
  /** Images attached to the user message (possibly its whole content). */
  attachments: ChatAttachment[]
  parts: AssistantPart[]
  /** The model-facing messages this turn contributed once it settled. */
  responseMessages: ModelMessage[]
  status: 'streaming' | 'done'
}

/** Whether a tool part is still awaiting its outcome. */
export function isToolPending(part: Extract<AssistantPart, { kind: 'tool' }>): boolean {
  return part.result === null && part.error === null
}

/**
 * Shown when a turn settles with no reply for the user — neither answer text
 * nor a notice of its own. The usual cause is the model spending its whole
 * step budget on tool calls without ever synthesizing (the engine's
 * `prepareStep` guards against this, so this is a backstop), but an empty
 * provider response lands here too.
 */
export const NO_REPLY_NOTICE =
  'I couldn’t finish answering — try narrowing your question or asking again.'

/** Whether the parts already carry something the user can read as a reply. */
function hasRenderableReply(parts: AssistantPart[]): boolean {
  return parts.some(
    (part) =>
      (part.kind === 'text' && part.text.trim() !== '') || part.kind === 'notice',
  )
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
        ...settleTools(parts, event.message, event.toolCallId),
        { kind: 'notice', tone: 'error', text: event.message },
      ]
    case 'error':
      // A terminal event settles every still-pending tool call — a chip must
      // never keep spinning after its turn is over.
      return [
        ...settleTools(parts, event.message),
        { kind: 'notice', tone: 'error', text: event.message },
      ]
    case 'aborted':
      return [
        ...settleTools(parts, 'Stopped.'),
        { kind: 'notice', tone: 'info', text: 'Stopped.' },
      ]
    case 'complete':
      // A turn can settle with no reply — e.g. the model spent its whole step
      // budget on tool calls and never synthesized. Rather than leave the user
      // with tool chips and silence, surface a notice.
      return hasRenderableReply(parts)
        ? parts
        : [...parts, { kind: 'notice', tone: 'info', text: NO_REPLY_NOTICE }]
  }
}

/**
 * Mark pending tool parts as failed with `message` — one call when a tool
 * errors (scoped by `toolCallId`), every still-pending call when the turn
 * itself ends in abort or error.
 */
function settleTools(
  parts: AssistantPart[],
  message: string,
  toolCallId?: string,
): AssistantPart[] {
  return parts.map((part): AssistantPart =>
    part.kind === 'tool' &&
    isToolPending(part) &&
    (toolCallId === undefined || part.call.toolCallId === toolCallId)
      ? { ...part, error: message }
      : part,
  )
}

/**
 * The model-facing user message for one turn: plain text when nothing is
 * attached, otherwise image parts (the data URL is the payload) followed by
 * the text — which may be absent entirely for a photo-only message.
 */
export function userMessage(
  text: string,
  attachments: readonly ChatAttachment[],
): ModelMessage {
  if (attachments.length === 0) {
    return { role: 'user', content: text }
  }
  return {
    role: 'user',
    content: [
      ...attachments.map((attachment) => ({
        type: 'image' as const,
        image: attachment.dataUrl,
        mediaType: attachment.mediaType,
      })),
      ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ],
  }
}

/**
 * The model-facing history a new turn resends: every user message followed
 * by the messages its turn contributed (tool calls and results included —
 * settled turns carry them even when stopped or failed part-way).
 *
 * A turn that produced **nothing** — failed before the provider replied, or
 * stopped before any output — is omitted user message and all: resending an
 * unanswered question would break the role alternation some providers
 * enforce, and invite the model to answer a question the transcript shows
 * as failed.
 */
export function buildHistory(turns: readonly ChatTurn[]): ModelMessage[] {
  return turns
    .filter((turn) => turn.responseMessages.length > 0)
    .flatMap((turn): ModelMessage[] => [
      userMessage(turn.userText, turn.attachments),
      ...turn.responseMessages,
    ])
}
