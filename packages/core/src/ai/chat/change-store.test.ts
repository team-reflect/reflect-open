import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../../ipc/bridge'
import {
  chatNoteChangesForTurn,
  pendingChatNoteChanges,
  prepareChatNoteChange,
  setChatNoteChangeState,
  setChatNoteChangesStateBatch,
  type ChatNoteChange,
} from './change-store'

const invoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

const change: ChatNoteChange = {
  id: 'change-1',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  path: 'notes/atlas.md',
  sequence: 0,
  operation: 'edit',
  beforeSource: '# Atlas\n\nBefore.\n',
  afterSource: '# Atlas\n\nAfter.\n',
  beforeRevision: 'a'.repeat(64),
  afterRevision: 'b'.repeat(64),
  state: 'prepared',
  errorMessage: null,
  createdMs: 1_000,
  updatedMs: 1_000,
}

beforeEach(() => {
  invoke.mockReset()
  setBridge({ invoke, listen: async () => () => {} })
})

afterEach(() => setBridge(null))

describe('chat note change store', () => {
  it('prepares a complete journal row before mutation', async () => {
    invoke.mockResolvedValue(change)
    const {
      state: _state,
      errorMessage: _errorMessage,
      updatedMs: _updatedMs,
      ...prepared
    } = change
    await expect(prepareChatNoteChange({ change: prepared, generation: 7 })).resolves.toEqual(
      change,
    )
    expect(invoke).toHaveBeenCalledWith('chat_note_change_prepare', {
      change: prepared,
      generation: 7,
    })
  })

  it('compare-and-sets lifecycle state', async () => {
    invoke.mockResolvedValue({ kind: 'updated', change: { ...change, state: 'applied' } })
    await expect(
      setChatNoteChangeState({
        id: change.id,
        expectedState: 'prepared',
        state: 'applied',
        errorMessage: null,
        updatedMs: 2_000,
        generation: 7,
      }),
    ).resolves.toMatchObject({ kind: 'updated', change: { state: 'applied' } })
  })

  it('atomically claims a group for Undo', async () => {
    const claimed = { ...change, state: 'undoing' as const }
    invoke.mockResolvedValue({ kind: 'updated', changes: [claimed] })
    await expect(
      setChatNoteChangesStateBatch({
        ids: [change.id],
        expectedState: 'applied',
        state: 'undoing',
        errorMessage: null,
        updatedMs: 2_000,
        generation: 7,
      }),
    ).resolves.toEqual({ kind: 'updated', changes: [claimed] })
    expect(invoke).toHaveBeenCalledWith('chat_note_changes_set_state_batch', {
      ids: [change.id],
      expectedState: 'applied',
      state: 'undoing',
      errorMessage: null,
      updatedMs: 2_000,
      generation: 7,
    })
  })

  it('loads ordered turn rows and pending reconciliation rows', async () => {
    invoke.mockResolvedValue([change])
    await expect(chatNoteChangesForTurn('turn-1', 7)).resolves.toEqual([change])
    expect(invoke).toHaveBeenLastCalledWith('chat_note_changes_for_turn', {
      turnId: 'turn-1',
      generation: 7,
    })

    await expect(pendingChatNoteChanges(7)).resolves.toEqual([change])
    expect(invoke).toHaveBeenLastCalledWith('chat_note_changes_pending', { generation: 7 })
  })
})
