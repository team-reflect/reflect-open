import { z } from 'zod'
import type { ModelMessage } from 'ai'
import { db } from '../../indexing/db'
import { call } from '../../ipc/invoke'
import { NOTE_MUTATION_FAILURE_CODES } from './note-mutations'
import {
  sourceProvenanceForParts,
  type AssistantPart,
  type ChatSourceProvenance,
  type ChatTurn,
} from './transcript'

/**
 * Chat history persistence (the durable `chat_*` tables in the graph's
 * index database). One {@link ChatTurn} persists as one `chat_messages` row;
 * its JSON columns are validated here on read, so a corrupt row is
 * dropped with a logged error instead of wedging the whole conversation
 * (per-entry resilience, the same policy as the settings document).
 *
 * Writes go through generation-gated Rust commands like every other index
 * mutation — a save issued for one graph can never land in another's
 * history. Reads ride the ordinary read-only Kysely `db_query` bridge.
 */

/** Chat write commands return `()` from Rust, which serializes to `null`. */
const voidSchema = z.null()

/** One conversation's metadata row. */
export interface ChatConversation {
  id: string
  /** First user message, truncated; fixed at creation. */
  title: string
  createdMs: number
  updatedMs: number
}

const hitSummarySchema = z.object({ path: z.string(), title: z.string() })
const toolSourceProvenanceSchema = z
  .array(z.object({ kind: z.enum(['note', 'asset']), path: z.string() }))
  .nullable()

/** One note's outcome in a persisted read_notes chip. */
const readNoteSummarySchema = z.object({
  path: z.string(),
  title: z.string().nullable(),
  error: z.string().nullable(),
})

const readAssetSummarySchema = z.object({
  path: z.string(),
  error: z.string().nullable(),
})

const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)

const mutationFailureCodeSchema = z.enum(NOTE_MUTATION_FAILURE_CODES)

const mutationOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    changeId: z.string(),
    path: z.string(),
    revision: revisionSchema,
    addedLines: z.number().int().nonnegative(),
    removedLines: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    code: mutationFailureCodeSchema,
    message: z.string(),
  }),
])

const toolCallSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('search'), toolCallId: z.string(), query: z.string() }),
  z.object({ tool: z.literal('read'), toolCallId: z.string(), paths: z.array(z.string()) }),
  z.object({ tool: z.literal('assets'), toolCallId: z.string(), paths: z.array(z.string()) }),
  z.object({ tool: z.literal('recents'), toolCallId: z.string(), tag: z.string().nullable() }),
  z.object({
    tool: z.literal('dailies'),
    toolCallId: z.string(),
    start: z.string(),
    end: z.string(),
  }),
  z.object({
    tool: z.literal('edit'),
    toolCallId: z.string(),
    path: z.string(),
    replacements: z.number().int().nonnegative(),
  }),
  z.object({ tool: z.literal('append'), toolCallId: z.string(), path: z.string() }),
  z.object({ tool: z.literal('create'), toolCallId: z.string(), title: z.string() }),
])

const toolResultSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('search'),
    toolCallId: z.string(),
    query: z.string(),
    hits: z.array(hitSummarySchema),
    sourceProvenance: toolSourceProvenanceSchema,
  }),
  z.object({
    tool: z.literal('read'),
    toolCallId: z.string(),
    notes: z.array(readNoteSummarySchema),
  }),
  z.object({
    tool: z.literal('assets'),
    toolCallId: z.string(),
    assets: z.array(readAssetSummarySchema),
  }),
  z.object({
    tool: z.literal('recents'),
    toolCallId: z.string(),
    tag: z.string().nullable(),
    notes: z.array(hitSummarySchema),
    error: z.string().nullable(),
  }),
  z.object({
    tool: z.literal('dailies'),
    toolCallId: z.string(),
    start: z.string(),
    end: z.string(),
    days: z.array(hitSummarySchema),
  }),
  z.object({ tool: z.literal('edit'), toolCallId: z.string(), outcome: mutationOutcomeSchema }),
  z.object({ tool: z.literal('append'), toolCallId: z.string(), outcome: mutationOutcomeSchema }),
  z.object({ tool: z.literal('create'), toolCallId: z.string(), outcome: mutationOutcomeSchema }),
])

const partSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    call: toolCallSchema,
    result: toolResultSchema.nullable(),
    error: z.string().nullable(),
  }),
  z.object({ kind: z.literal('notice'), tone: z.enum(['error', 'info']), text: z.string() }),
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Upgrade assistant tool parts from older persisted contracts. Before
 * read_notes batching, the read tool was single-note: call `{ path }`, result
 * `{ path, title, error }`. Before asset-aware search attribution, search
 * results had no source provenance; those are conservatively unclassifiable.
 * Rewrites both shapes so old history loads without treating legacy search
 * results as note-only evidence.
 */
function upgradeLegacyReadPart(part: unknown): unknown {
  if (!isRecord(part) || part['kind'] !== 'tool') {
    return part
  }
  const upgraded: Record<string, unknown> = { ...part }
  const rawCall = part['call']
  const rawResult = part['result']
  if (
    isRecord(rawCall) &&
    rawCall['tool'] === 'read' &&
    'path' in rawCall &&
    !('paths' in rawCall)
  ) {
    const { path, ...rest } = rawCall
    upgraded['call'] = { ...rest, paths: [path] }
  }
  if (
    isRecord(rawResult) &&
    rawResult['tool'] === 'read' &&
    'path' in rawResult &&
    !('notes' in rawResult)
  ) {
    const { path, title, error, ...rest } = rawResult
    upgraded['result'] = { ...rest, notes: [{ path, title: title ?? null, error: error ?? null }] }
  }
  const upgradedResult = upgraded['result']
  if (
    isRecord(upgradedResult) &&
    upgradedResult['tool'] === 'search' &&
    !('sourceProvenance' in upgradedResult)
  ) {
    upgraded['result'] = { ...upgradedResult, sourceProvenance: null }
  }
  return upgraded
}

const partsSchema: z.ZodType<AssistantPart[]> = z.array(
  z.preprocess(upgradeLegacyReadPart, partSchema),
)

const attachmentsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    mediaType: z.string(),
    dataUrl: z.string(),
  }),
)

const permissionModeSchema = z.enum(['read', 'readWrite'])
const sourceProvenanceSchema: z.ZodType<Exclude<ChatSourceProvenance, null>> = z.array(
  z.object({ kind: z.enum(['note', 'asset']), path: z.string() }),
)

/**
 * Persisted model messages are validated by envelope only — the AI SDK's
 * content unions are wide and provider-shaped, and we stored exactly what the
 * SDK produced, so re-encoding its full shape here would just chase the SDK's
 * types. The cast back to {@link ModelMessage} is sound for rows this app
 * wrote; gross corruption still fails the envelope and drops the row.
 */
const responseMessagesSchema = z.array(
  z.looseObject({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.unknown(),
  }),
)

/**
 * Save one turn (and upsert its conversation row) for `generation`. The
 * turn's position (`seq`) is assigned by Rust inside the insert — never
 * here: this side's view of a conversation can undercount the table (see
 * {@link loadChatMessages} dropping unreadable rows), so a counter derived
 * from it could collide with a row it never saw.
 */
export async function saveChatMessage(input: {
  conversation: ChatConversation
  turn: ChatTurn
  createdMs: number
  generation: number
}): Promise<void> {
  await call(
    'chat_message_save',
    {
      conversation: input.conversation,
      message: {
        id: input.turn.id,
        conversationId: input.conversation.id,
        permissionMode: input.turn.permissionMode,
        userText: input.turn.userText,
        attachments: JSON.stringify(input.turn.attachments),
        parts: JSON.stringify(input.turn.parts),
        responseMessages: JSON.stringify(input.turn.responseMessages),
        sourceProvenance:
          input.turn.sourceProvenance === null ? null : JSON.stringify(input.turn.sourceProvenance),
        createdMs: input.createdMs,
      },
      generation: input.generation,
    },
    voidSchema,
  )
}

/** Delete a conversation and its messages (for `generation`). */
export async function deleteChatConversation(id: string, generation: number): Promise<void> {
  await call('chat_conversation_delete', { id, generation }, voidSchema)
}

/** The most recently active conversations, newest first. */
export async function listChatConversations(limit = 50): Promise<ChatConversation[]> {
  return await db
    .selectFrom('chatConversations')
    .select(['id', 'title', 'createdMs', 'updatedMs'])
    .orderBy('updatedMs', 'desc')
    .limit(limit)
    .execute()
}

/**
 * Load a conversation's turns in order. Restored turns are always `done` —
 * a row whose stream never settled (crash mid-turn) comes back with empty
 * `responseMessages`, which `buildHistory` already omits from the model view.
 */
export async function loadChatMessages(conversationId: string): Promise<ChatTurn[]> {
  const rows = await db
    .selectFrom('chatMessages')
    .selectAll()
    .where('conversationId', '=', conversationId)
    .orderBy('seq', 'asc')
    .execute()
  return rows.flatMap((row) => {
    const turn = parseTurn(row)
    if (turn === null) {
      console.error(`dropping unreadable chat message ${row.id} in ${conversationId}`)
      return []
    }
    return [turn]
  })
}

interface StoredMessageRow {
  id: string
  permissionMode?: string | null
  userText: string
  attachments: string
  parts: string
  responseMessages: string
  sourceProvenance?: string | null
}

function parseTurn(row: StoredMessageRow): ChatTurn | null {
  const attachments = parseJson(row.attachments, attachmentsSchema)
  const parts = parseJson(row.parts, partsSchema)
  const responseMessages = parseJson(row.responseMessages, responseMessagesSchema)
  const permissionMode = permissionModeSchema.safeParse(row.permissionMode ?? 'read')
  const storedProvenance =
    row.sourceProvenance == null
      ? undefined
      : parseJson(row.sourceProvenance, sourceProvenanceSchema)
  if (
    attachments === null ||
    parts === null ||
    responseMessages === null ||
    !permissionMode.success ||
    storedProvenance === null
  ) {
    return null
  }
  const messages = responseMessages as ModelMessage[]
  return {
    id: row.id,
    permissionMode: permissionMode.data,
    userText: row.userText,
    attachments,
    parts,
    // See responseMessagesSchema: envelope-validated, shape owned by the SDK.
    responseMessages: messages,
    sourceProvenance: storedProvenance ?? sourceProvenanceForParts(parts, messages),
    status: 'done',
  }
}

function parseJson<TOutput>(raw: string, schema: z.ZodType<TOutput>): TOutput | null {
  try {
    const result = schema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}
