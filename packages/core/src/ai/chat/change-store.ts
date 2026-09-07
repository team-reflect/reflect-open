import { z } from 'zod'
import { call } from '../../ipc/invoke'

/** Kind of source change recorded in the durable AI journal. */
export type ChatNoteChangeOperation = 'edit' | 'append' | 'create'

/** Lifecycle state of one durable AI change-journal row. */
export type ChatNoteChangeState =
  | 'prepared'
  | 'applied'
  | 'undoing'
  | 'undone'
  | 'failed'
  | 'uncertain'

/** Durable, device-local before/after journal row for one AI tool operation. */
export interface ChatNoteChange {
  id: string
  conversationId: string
  turnId: string
  toolCallId: string
  path: string
  sequence: number
  operation: ChatNoteChangeOperation
  beforeSource: string | null
  afterSource: string
  beforeRevision: string | null
  afterRevision: string
  state: ChatNoteChangeState
  errorMessage: string | null
  createdMs: number
  updatedMs: number
}

/** Input persisted in `prepared` state before the corresponding note write. */
export type PrepareChatNoteChangeInput = Omit<
  ChatNoteChange,
  'state' | 'errorMessage' | 'updatedMs'
>

const operationSchema = z.enum(['edit', 'append', 'create'])
const stateSchema = z.enum(['prepared', 'applied', 'undoing', 'undone', 'failed', 'uncertain'])
const revisionSchema = z.string().regex(/^[0-9a-f]{64}$/)
const changeSchema: z.ZodType<ChatNoteChange> = z.object({
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  path: z.string(),
  sequence: z.number().int().nonnegative(),
  operation: operationSchema,
  beforeSource: z.string().nullable(),
  afterSource: z.string(),
  beforeRevision: revisionSchema.nullable(),
  afterRevision: revisionSchema,
  state: stateSchema,
  errorMessage: z.string().nullable(),
  createdMs: z.number(),
  updatedMs: z.number(),
})

/** Journal one intended change. This must resolve before filesystem mutation starts. */
export async function prepareChatNoteChange(input: {
  change: PrepareChatNoteChangeInput
  generation: number
}): Promise<ChatNoteChange> {
  return await call('chat_note_change_prepare', input, changeSchema)
}

/** Outcome of a compare-and-set journal state transition. */
export type SetChatNoteChangeStateResult =
  | { kind: 'updated'; change: ChatNoteChange }
  | { kind: 'stateMismatch'; change: ChatNoteChange }
  | { kind: 'missing' }

const setStateResultSchema: z.ZodType<SetChatNoteChangeStateResult> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('updated'), change: changeSchema }),
  z.object({ kind: z.literal('stateMismatch'), change: changeSchema }),
  z.object({ kind: z.literal('missing') }),
])

/** Compare-and-set one journal row's lifecycle state. */
export async function setChatNoteChangeState(input: {
  id: string
  expectedState: ChatNoteChangeState
  state: ChatNoteChangeState
  errorMessage: string | null
  updatedMs: number
  generation: number
}): Promise<SetChatNoteChangeStateResult> {
  return await call('chat_note_change_set_state', input, setStateResultSchema)
}

/** Outcome of one all-or-none compare-and-set over a group of journal rows. */
export type SetChatNoteChangesStateBatchResult =
  | { kind: 'updated'; changes: ChatNoteChange[] }
  | { kind: 'stateMismatch'; changes: ChatNoteChange[] }
  | { kind: 'missing'; missingIds: string[] }

const setStateBatchResultSchema: z.ZodType<SetChatNoteChangesStateBatchResult> =
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('updated'), changes: z.array(changeSchema) }),
    z.object({ kind: z.literal('stateMismatch'), changes: z.array(changeSchema) }),
    z.object({ kind: z.literal('missing'), missingIds: z.array(z.string()) }),
  ])

/** Atomically compare-and-set every journal row in one Undo group. */
export async function setChatNoteChangesStateBatch(input: {
  ids: string[]
  expectedState: ChatNoteChangeState
  state: ChatNoteChangeState
  errorMessage: string | null
  updatedMs: number
  generation: number
}): Promise<SetChatNoteChangesStateBatchResult> {
  return await call('chat_note_changes_set_state_batch', input, setStateBatchResultSchema)
}

const changesSchema = z.array(changeSchema)

/** Ordered journal rows for one settled or in-flight chat turn. */
export async function chatNoteChangesForTurn(
  turnId: string,
  generation: number,
): Promise<ChatNoteChange[]> {
  return await call('chat_note_changes_for_turn', { turnId, generation }, changesSchema)
}

/** Rows requiring crash reconciliation when a graph opens. */
export async function pendingChatNoteChanges(generation: number): Promise<ChatNoteChange[]> {
  return await call('chat_note_changes_pending', { generation }, changesSchema)
}
