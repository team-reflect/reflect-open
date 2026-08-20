import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/lib/query-client'
import {
  createChatConversationsQueryOptions,
  createConflictedNotesQueryOptions,
  createDailyDatesQueryOptions,
  createDuplicateNoteIdsQueryOptions,
  createTemplatesQueryOptions,
} from '@/lib/query-options'
import {
  createCompletedTasksQueryOptions,
  createOpenTasksQueryOptions,
} from '@/lib/tasks/tasks-query'

const core = vi.hoisted(() => ({
  dailyDatesInRange: vi.fn(),
  getConflictedNotes: vi.fn(),
  getDuplicateNoteIds: vi.fn(),
  getCompletedTasks: vi.fn(),
  getOpenTasks: vi.fn(),
  listChatConversations: vi.fn(),
  listTemplates: vi.fn(),
}))

vi.mock('@reflect/core', () => core)

beforeEach(() => {
  vi.clearAllMocks()
  for (const getter of Object.values(core)) {
    getter.mockResolvedValue([])
  }
})

describe('shared query options', () => {
  it('share registry identities across consumers', () => {
    expect(createConflictedNotesQueryOptions('/graph').queryKey).toEqual(
      queryKeys.index.conflictedNotes('/graph'),
    )
    expect(createDuplicateNoteIdsQueryOptions('/graph').queryKey).toEqual(
      queryKeys.index.duplicateNoteIds('/graph'),
    )
    expect(createTemplatesQueryOptions('/graph').queryKey).toEqual(
      queryKeys.index.templates('/graph'),
    )
    expect(createDailyDatesQueryOptions('/graph', '2026-08-01', '2026-08-31').queryKey).toEqual(
      queryKeys.index.dailyDates('/graph', '2026-08-01', '2026-08-31'),
    )
    expect(createChatConversationsQueryOptions('/graph').queryKey).toEqual(
      queryKeys.chat.conversations('/graph'),
    )
    expect(createOpenTasksQueryOptions('/graph').queryKey).toEqual(
      queryKeys.index.openTasks('/graph'),
    )
    expect(createCompletedTasksQueryOptions('/graph').queryKey).toEqual(
      queryKeys.index.completedTasks('/graph'),
    )
  })

  it('binds the getter and its parameters once', async () => {
    const client = new QueryClient()

    await client.fetchQuery(createDailyDatesQueryOptions('/graph', '2026-08-01', '2026-08-31'))

    expect(core.dailyDatesInRange).toHaveBeenCalledWith('2026-08-01', '2026-08-31')
  })
})
