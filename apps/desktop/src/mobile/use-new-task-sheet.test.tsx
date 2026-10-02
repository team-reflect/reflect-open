import { act } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { insertedTaskRow } from '@/lib/tasks/task-insert-target.ts'
import { todaysDailyTarget } from '@/lib/tasks/task-navigation.ts'
import { useNewTaskSheet } from './use-new-task-sheet.ts'

const TODAY = '2026-06-14'

const insert = vi.hoisted(() => vi.fn())

vi.mock('@/lib/tasks/use-task-actions.ts', () => ({
  useTaskActions: () => ({ insert }),
}))

vi.mock('@/lib/use-today.ts', () => ({
  useToday: () => TODAY,
}))

beforeEach(() => {
  insert.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('useNewTaskSheet', () => {
  it('starts closed with no task', async () => {
    const { result } = await renderHook(() => useNewTaskSheet())

    expect(result.current.task).toBeNull()
    expect(result.current.open).toBe(false)
    expect(result.current.today).toBe(TODAY)
  })

  it("adds an empty task to today's daily note, then opens the sheet on it", async () => {
    const created: OpenTask = insertedTaskRow(todaysDailyTarget(TODAY), 2)
    insert.mockResolvedValue(created)
    const { result } = await renderHook(() => useNewTaskSheet())

    act(() => result.current.start())

    expect(insert).toHaveBeenCalledWith(todaysDailyTarget(TODAY))
    await vi.waitFor(() => expect(result.current.open).toBe(true))
    expect(result.current.task).toBe(created)
  })

  it('stays closed when the insert fails', async () => {
    // A failed insert resolves null; the task actions already surfaced why.
    insert.mockResolvedValue(null)
    const { result } = await renderHook(() => useNewTaskSheet())

    act(() => result.current.start())

    // waitFor polls on timers, so start's continuation has run by the time it passes.
    await vi.waitFor(() => expect(insert).toHaveResolved())
    expect(result.current.task).toBeNull()
    expect(result.current.open).toBe(false)
  })
})
