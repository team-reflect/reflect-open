import { z } from 'zod'
import type { ModelMessage } from 'ai'
import { db } from '../../indexing/db'
import { call } from '../../ipc/invoke'
import type { AssistantPart, ChatTurn } from './transcript'

/**
 * Chat history persistence (the durable `chat_*` tables in the graph's
 * index database). One {@link ChatTurn} persists as one `chat_messages` row;
 * its three JSON columns are validated here on read, so a corrupt row is
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

const toolCallSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('search'), toolCallId: z.string(), query: z.string() }),
  z.object({ tool: z.literal('read'), toolCallId: z.string(), path: z.string() }),
  z.object({ tool: z.literal('recents'), toolCallId: z.string(), tag: z.string().nullable() }),
  z.object({
    tool: z.literal('dailies'),
    toolCallId: z.string(),
    start: z.string(),
    end: z.string(),
  }),
])

const toolResultSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('search'),
    toolCallId: z.string(),
    query: z.string(),
    hits: z.array(hitSummarySchema),
  }),
  z.object({
    tool: z.literal('read'),
    toolCallId: z.string(),
    path: z.string(),
    title: z.string().nullable(),
    error: z.string().nullable(),
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
])

const partsSchema: z.ZodType<AssistantPart[]> = z.array(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({
      kind: z.literal('tool'),
      call: toolCallSchema,
      result: toolResultSchema.nullable(),
      error: z.string().nullable(),
    }),
    z.object({ kind: z.literal('notice'), tone: z.enum(['error', 'info']), text: z.string() }),
  ]),
)

const attachmentsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    mediaType: z.string(),
    dataUrl: z.string(),
  }),
)

/**
 * Persisted model messages are validated by envelope only — the AI SDK's
 * content unions are wide and provider-shaped, and we stored exactly what the
 * SDK produced, so re-encoding its full shape here would just chase the SDK's
 * types. The cast back to {@link ModelMessage} is sound for rows this app
 * wrote; gross corruption still fails the envelope and drops the row.
 */
const responseMessagesSchema = z.array(
  z
    .object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.unknown(),
    })
    .passthrough(),
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
        userText: input.turn.userText,
        attachments: JSON.stringify(input.turn.attachments),
        parts: JSON.stringify(input.turn.parts),
        responseMessages: JSON.stringify(input.turn.responseMessages),
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
  return db
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
    .select(['id', 'userText', 'attachments', 'parts', 'responseMessages'])
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
  userText: string
  attachments: string
  parts: string
  responseMessages: string
}

function parseTurn(row: StoredMessageRow): ChatTurn | null {
  const attachments = parseJson(row.attachments, attachmentsSchema)
  const parts = parseJson(row.parts, partsSchema)
  const responseMessages = parseJson(row.responseMessages, responseMessagesSchema)
  if (attachments === null || parts === null || responseMessages === null) {
    return null
  }
  return {
    id: row.id,
    userText: row.userText,
    attachments,
    parts,
    // See responseMessagesSchema: envelope-validated, shape owned by the SDK.
    responseMessages: responseMessages as ModelMessage[],
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
