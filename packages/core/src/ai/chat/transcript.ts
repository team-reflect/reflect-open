import type { ModelMessage } from 'ai'
import type { ChatStreamEvent } from './stream-chat'
import type { NoteToolCall, NoteToolResult } from './tools'
import type { ChatPermissionMode } from './permissions'

/**
 * The chat conversation model (Plan 10). A {@link ChatTurn} is the single
 * source of truth for one exchange: the user's text and image attachments,
 * the assistant's renderable parts, and the model-facing messages the turn
 * contributed. Hosts store only turns — the history a new turn resends is
 * derived via {@link buildHistory}; provider call sites use
 * {@link buildPrivacySafeHistory} to remove a history suffix whose app-sourced
 * material is no longer sendable. The same record is what the store persists,
 * so privacy filtering never destroys the local transcript.
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

/** App-sourced material an earlier answer may have derived from. */
export interface ChatSourceRef {
  kind: 'note' | 'asset'
  path: string
}

/** `null` means a legacy turn's tool provenance cannot be classified safely. */
export type ChatSourceProvenance = ChatSourceRef[] | null

/** One renderable slice of an assistant message. */
export type AssistantPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; call: NoteToolCall; result: NoteToolResult | null; error: string | null }
  | { kind: 'notice'; tone: 'error' | 'info'; text: string }

/** One user message and everything the assistant did in response. */
export interface ChatTurn {
  id: string
  /** Capability captured when this turn was sent; restored chats never re-grant it. */
  permissionMode: ChatPermissionMode
  userText: string
  /** Images attached to the user message (possibly its whole content). */
  attachments: ChatAttachment[]
  parts: AssistantPart[]
  /** The model-facing messages this turn contributed once it settled. */
  responseMessages: ModelMessage[]
  /** Sources to revalidate before any later provider request. */
  sourceProvenance: ChatSourceProvenance
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
    (part) => (part.kind === 'text' && part.text.trim() !== '') || part.kind === 'notice',
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
      return [...settleTools(parts, 'Stopped.'), { kind: 'notice', tone: 'info', text: 'Stopped.' }]
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
  return parts.map(
    (part): AssistantPart =>
      part.kind === 'tool' &&
      isToolPending(part) &&
      (toolCallId === undefined || part.call.toolCallId === toolCallId)
        ? { ...part, error: message }
        : part,
  )
}

/**
 * The model-facing user message for one turn: plain text when nothing is
 * attached, otherwise image file parts (the data URL is the payload) followed by
 * the text — which may be absent entirely for a photo-only message.
 */
export function userMessage(text: string, attachments: readonly ChatAttachment[]): ModelMessage {
  if (attachments.length === 0) {
    return { role: 'user', content: text }
  }
  return {
    role: 'user',
    content: [
      ...attachments.map((attachment) => ({
        type: 'file' as const,
        data: attachment.dataUrl,
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

/**
 * Build provider history while revalidating every app-sourced note and asset.
 * Once a source is private, unreadable, or unclassifiable, the contaminated
 * turn and the whole suffix after it are omitted; the local transcript stays
 * untouched.
 */
export async function buildPrivacySafeHistory(
  turns: readonly ChatTurn[],
  validate: (source: ChatSourceRef) => Promise<boolean>,
): Promise<ModelMessage[]> {
  const history: ModelMessage[] = []
  for (const turn of turns) {
    if (turn.responseMessages.length === 0) {
      continue
    }
    const provenance = resolvedSourceProvenance(turn)
    if (provenance === null) {
      break
    }
    const verdicts = await Promise.all(
      provenance.map(async (source) => {
        try {
          return await validate(source)
        } catch {
          return false
        }
      }),
    )
    if (verdicts.some((allowed) => !allowed)) {
      break
    }
    history.push(userMessage(turn.userText, turn.attachments), ...turn.responseMessages)
  }
  return history
}

/** Provider-safe source paths exposed by one settled tool result. */
export function sourceProvenanceForResult(result: NoteToolResult): ChatSourceProvenance {
  switch (result.tool) {
    case 'search':
      return result.sourceProvenance
    case 'read':
      return result.notes.flatMap((note) =>
        note.error === null ? [{ kind: 'note' as const, path: note.path }] : [],
      )
    case 'assets':
      return result.assets.flatMap((asset) =>
        asset.error === null ? [{ kind: 'asset' as const, path: asset.path }] : [],
      )
    case 'recents':
      return result.notes.map((note) => ({ kind: 'note', path: note.path }))
    case 'dailies':
      return result.days.map((note) => ({ kind: 'note', path: note.path }))
    case 'edit':
    case 'append':
    case 'create':
      return result.outcome.ok ? [{ kind: 'note', path: result.outcome.path }] : []
  }
}

/** Add one result's sources without duplicating a kind/path pair. */
export function mergeSourceProvenance(
  provenance: ChatSourceProvenance,
  result: NoteToolResult,
): ChatSourceProvenance {
  if (provenance === null) {
    return null
  }
  const resultProvenance = sourceProvenanceForResult(result)
  if (resultProvenance === null) {
    return null
  }
  const merged = new Map(provenance.map((source) => [sourceKey(source), source]))
  for (const source of resultProvenance) {
    merged.set(sourceKey(source), source)
  }
  return [...merged.values()]
}

/** Derive known provenance from renderable parts (used to upgrade legacy rows). */
export function sourceProvenanceForParts(
  parts: readonly AssistantPart[],
  responseMessages: readonly ModelMessage[] = [],
): ChatSourceProvenance {
  const representedCalls = new Map<string, Extract<AssistantPart, { kind: 'tool' }>>()
  let provenance: ChatSourceProvenance = []
  for (const part of parts) {
    if (part.kind !== 'tool') {
      continue
    }
    representedCalls.set(part.call.toolCallId, part)
    if (part.result !== null) {
      provenance = mergeSourceProvenance(provenance, part.result)
    }
  }
  const modelTools = modelToolIds(responseMessages)
  const everyCallIsRepresented = [...modelTools.calls].every((toolCallId) =>
    representedCalls.has(toolCallId),
  )
  const everyResultIsClassified = [...modelTools.results].every((toolCallId) => {
    const represented = representedCalls.get(toolCallId)
    return (
      represented !== undefined &&
      represented.result !== null &&
      represented.result.toolCallId === toolCallId &&
      represented.result.tool === represented.call.tool
    )
  })
  return everyCallIsRepresented && everyResultIsClassified ? provenance : null
}

function resolvedSourceProvenance(turn: ChatTurn): ChatSourceProvenance {
  const derived = sourceProvenanceForParts(turn.parts, turn.responseMessages)
  if (derived === null || turn.sourceProvenance === null) {
    return null
  }
  let merged: ChatSourceProvenance = turn.sourceProvenance
  for (const part of turn.parts) {
    if (part.kind === 'tool' && part.result !== null) {
      merged = mergeSourceProvenance(merged, part.result)
    }
  }
  return merged
}

interface ModelToolIds {
  readonly calls: Set<string>
  readonly results: Set<string>
}

function modelToolIds(messages: readonly ModelMessage[]): ModelToolIds {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const message of messages) {
    collectModelToolIds(message.content, calls, results)
  }
  return { calls, results }
}

function collectModelToolIds(value: unknown, calls: Set<string>, results: Set<string>): void {
  if (!Array.isArray(value)) {
    return
  }
  const entries: readonly unknown[] = value
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('type' in entry) ||
      !('toolCallId' in entry) ||
      typeof entry.toolCallId !== 'string'
    ) {
      continue
    }
    const toolCallId = entry.toolCallId
    if (entry.type === 'tool-call') {
      calls.add(toolCallId)
    } else if (entry.type === 'tool-result') {
      results.add(toolCallId)
    }
  }
}

function sourceKey(source: ChatSourceRef): string {
  return `${source.kind}:${source.path}`
}
