import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { ModelMessage } from '@reflect/modules/ai'
import type { LoggerService } from '../../ports/logger-service.ts'
import type { DatabaseService } from '../../indexing/database-service.ts'
import type { IpcBridgeService } from '../../ipc/ipc-service.ts'
import type { AssistantPart, ChatTurn } from './transcript.ts'

/**
 * Chat history persistence (the durable `chat_*` tables in the graph's
 * index database). One {@link ChatTurn} persists as one `chat_messages` row;
 * its three JSON columns are validated here on read, so a corrupt row is
 * dropped with a logged error instead of wedging the whole conversation
 * (per-entry resilience, the same policy as the settings document).
 *
 * Writes go through generation-gated Rust commands like every other index
 * mutation: a save issued for one graph can never land in another's
 * history. Reads ride the ordinary read-only Kysely `db_query` bridge.
 */

/**
 * Chat write commands return `()` from Rust, which serializes to `null`.
 */
const voidSchema = z.null()

/**
 * One conversation's metadata row.
 */
export interface ChatConversation {
  id: string
  /**
   * First user message, truncated; fixed at creation.
   */
  title: string
  createdMs: number
  updatedMs: number
}

const hitSummarySchema = z.object({ path: z.string(), title: z.string() })

/**
 * One note's outcome in a persisted read_notes chip.
 */
const readNoteSummarySchema = z.object({
  path: z.string(),
  title: z.string().nullable(),
  error: z.string().nullable(),
})

const toolCallSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('search'), toolCallId: z.string(), query: z.string() }),
  z.object({ tool: z.literal('read'), toolCallId: z.string(), paths: z.array(z.string()) }),
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
    notes: z.array(readNoteSummarySchema),
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
 * Upgrade an assistant part persisted before read_notes (Plan 10 first wave):
 * the read tool was single-note (call `{ path }`, result `{ path, title,
 * error }`) and is now a batch (call `{ paths }`, result `{ notes: [...] }`).
 * Rewrites those legacy shapes so old chat history still loads; a part already
 * in the current shape passes through untouched.
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

/**
 * Persisted model messages are validated by envelope only: the AI SDK's
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
 * One turn to persist, with the conversation row it upserts.
 */
export interface SaveChatTurnInput {
  conversation: ChatConversation
  turn: ChatTurn
  createdMs: number
  generation: number
}

export interface ChatHistoryServiceDeps {
  readonly ipc: IpcBridgeService
  readonly database: DatabaseService
  readonly logger: LoggerService
}

/**
 * The graph's persisted chat conversations.
 */
export interface ChatHistoryService {
  /**
   * Save one turn (and upsert its conversation row) for `generation`. The
   * turn's position (`seq`) is assigned by Rust inside the insert, never
   * here: this side's view of a conversation can undercount the table (see
   * {@link loadConversation} dropping unreadable rows), so a counter derived
   * from it could collide with a row it never saw.
   */
  saveTurn(input: SaveChatTurnInput): MaybePromise<void>
  /**
   * Delete a conversation and its messages (for `generation`).
   */
  deleteConversation(id: string, generation: number): MaybePromise<void>
  /**
   * The most recently active conversations, newest first. Defaults to 50.
   */
  listRecent(limit?: number): MaybePromise<ChatConversation[]>
  /**
   * Load a conversation's turns in order. Restored turns are always `done`:
   * a row whose stream never settled (crash mid-turn) comes back with empty
   * `responseMessages`, which `buildHistory` already omits from the model view.
   */
  loadConversation(conversationId: string): MaybePromise<ChatTurn[]>
}

class ChatHistoryServiceImpl implements ChatHistoryService {
  readonly #deps: ChatHistoryServiceDeps

  constructor(deps: ChatHistoryServiceDeps) {
    this.#deps = deps
  }

  async saveTurn(input: SaveChatTurnInput): Promise<void> {
    await this.#deps.ipc.call(
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

  async deleteConversation(id: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('chat_conversation_delete', { id, generation }, voidSchema)
  }

  async listRecent(limit = 50): Promise<ChatConversation[]> {
    return await this.#deps.database.db
      .selectFrom('chatConversations')
      .select(['id', 'title', 'createdMs', 'updatedMs'])
      .orderBy('updatedMs', 'desc')
      .limit(limit)
      .execute()
  }

  async loadConversation(conversationId: string): Promise<ChatTurn[]> {
    const { database, logger } = this.#deps
    const rows = await database.db
      .selectFrom('chatMessages')
      .select(['id', 'userText', 'attachments', 'parts', 'responseMessages'])
      .where('conversationId', '=', conversationId)
      .orderBy('seq', 'asc')
      .execute()
    return rows.flatMap((row) => {
      const turn = parseTurn(row)
      if (turn === null) {
        logger.error(`dropping unreadable chat message ${row.id} in ${conversationId}`)
        return []
      }
      return [turn]
    })
  }
}

export function createChatHistoryService(deps: ChatHistoryServiceDeps): ChatHistoryService {
  return new ChatHistoryServiceImpl(deps)
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
