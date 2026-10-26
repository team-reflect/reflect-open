import { act } from '@/test-utils/act.ts'
import { beforeEach, describe, expect, it } from 'vitest'
import { getTaskKey, type OpenTask, type TaskService, type TaskSnapshot } from '@reflect/core'
import {
  createTestCoreServices,
  makeOpenTask as task,
  type TestCoreServices,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useRecentlyCompleted } from './recently-completed.ts'

/**
 * A struck task as the note holds it: checked, unless a case says otherwise.
 */
function snapshot(astPath: number[], markdown: string, checked = true): TaskSnapshot {
  return { astPath, markdown, breadcrumbs: [], checked }
}

let core: TestCoreServices
let tasks: TaskService

// A fresh service per test, so its recently-completed set starts empty.
beforeEach(() => {
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  tasks = core.tasks
})

describe('recently-completed', () => {
  it('keeps session completions showing, as checked', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    expect(result.current).toEqual([])

    await act(() => tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2] })]))
    expect(result.current).toHaveLength(1)
    // `checked` matches disk: these rows outlive the reindex, so a stale
    // `false` would later fail a reopen/edit/delete write-back.
    expect(result.current[0]!.checked).toBe(true)
  })

  it('dedupes by task key', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    const taskRow = task({ notePath: 'a.md', astPath: [2] })
    await act(() => tasks.markRecentlyCompleted('/g', [taskRow]))
    await act(() => tasks.markRecentlyCompleted('/g', [taskRow]))
    expect(result.current).toHaveLength(1)
  })

  it('forgets dropped keys and clears on archive', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2] }),
        task({ notePath: 'b.md', astPath: [2] }),
      ])
    })
    await act(() => tasks.forgetRecentlyCompleted('/g', ['a.md:[2]']))
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])

    await act(() => tasks.archiveRecentlyCompleted('/g'))
    expect(result.current).toEqual([])
  })

  it('relocates struck rows a note write moved', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [4], markdown: 'done' }),
        task({ notePath: 'b.md', astPath: [4], markdown: 'other' }),
      ])
    })

    await act(() => {
      tasks.relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([4], 'done'), to: snapshot([5], 'done') },
      ])
    })

    expect(result.current.map((row) => getTaskKey(row))).toEqual(['a.md:[5]', 'b.md:[4]'])
    expect(result.current[0]?.checked).toBe(true)
  })

  it('drops a struck row whose task the write removed', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [1] })]))

    await act(() => {
      tasks.relocateRecentlyCompleted('/g', 'a.md', [{ from: snapshot([1], 'do it'), to: null }])
    })

    expect(result.current).toEqual([])
  })

  it('refreshes an edited struck row from its persisted Markdown', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], markdown: 'old' })])
    })

    await act(() => {
      tasks.relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([2], 'old'), to: snapshot([2], 'edited [[2026-07-01]]') },
      ])
    })

    expect(result.current[0]).toMatchObject({
      markdown: 'edited [[2026-07-01]]',
      text: 'edited 2026-07-01',
      dueDate: '2026-07-01',
    })
  })

  it('leaves a struck row alone when the write did not know its task', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [1], markdown: 'dup' })])
    })

    await act(() => {
      tasks.relocateRecentlyCompleted('/g', 'a.md', [
        { from: snapshot([2], 'other'), to: snapshot([3], 'other') },
      ])
    })

    expect(result.current.map((row) => getTaskKey(row))).toEqual(['a.md:[1]'])
  })

  it('drops a struck copy when the index reports the task open again with a newer updatedAt', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })])
    })
    expect(result.current).toHaveLength(1)

    // The source note was rewritten (checkbox flipped back to [ ]) and reindexed:
    // the live open row supersedes the session's struck shadow.
    await act(() => {
      tasks.reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 200 }),
      ])
    })
    expect(result.current).toEqual([])
  })

  it('keeps the struck copy when the open row is the pre-completion index state', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })])
    })

    // A refetch racing the completion's reindex restores the row unchanged
    // (same updatedAt) — the shadow must hold or the row flickers back open.
    await act(() => {
      tasks.reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 100 }),
      ])
    })
    expect(result.current).toHaveLength(1)
  })

  it('reconciles only the active graph root, and leaves unrelated struck tasks alone', async () => {
    const { result } = await renderHookInApp(() => useRecentlyCompleted('/g', undefined), { core })
    await act(() => {
      tasks.markRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 100 }),
        task({ notePath: 'b.md', astPath: [2], updatedAt: 100 }),
      ])
    })

    await act(() => {
      tasks.reconcileRecentlyCompleted('/other', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 200 }),
      ])
    })
    expect(result.current).toHaveLength(2)

    await act(() => {
      tasks.reconcileRecentlyCompleted('/g', [
        task({ notePath: 'a.md', astPath: [2], updatedAt: 200 }),
      ])
    })
    expect(result.current.map((row) => row.notePath)).toEqual(['b.md'])
  })

  it('useRecentlyCompleted reconciles against the open rows it is given', async () => {
    const { result, rerender } = await renderHookInApp(
      (
        { open }: { open: readonly OpenTask[] | undefined } = {
          open: undefined,
        },
      ) => useRecentlyCompleted('/g', open),
      { core, initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })])
    })
    expect(result.current).toHaveLength(1)

    // A fresh open read carrying the reopened row (newer updatedAt) sheds the
    // shadow from the view AND prunes the store, so the Archive count and
    // hasRecentlyCompleted agree with what renders.
    await rerender({
      open: [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })],
    })
    expect(result.current).toEqual([])
    expect(tasks.hasRecentlyCompleted('/g', 'a.md:[2]')).toBe(false)
  })

  it('excludes a reopened task during the render that sees it, before the store prune', async () => {
    // Render-phase capture: each entry is what a render (not an effect) returned,
    // so a superseded shadow surviving into the first fresh-data render would
    // record a 1 here even though a later effect prunes it.
    const lengths: number[] = []
    const { rerender } = await renderHookInApp(
      (
        { open }: { open: readonly OpenTask[] | undefined } = {
          open: undefined,
        },
      ) => {
        const rows = useRecentlyCompleted('/g', open)
        lengths.push(rows.length)
        return rows
      },
      { core, initialProps: { open: undefined as readonly OpenTask[] | undefined } },
    )
    await act(() => {
      tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2], updatedAt: 100 })])
    })
    const renders = lengths.length

    await rerender({
      open: [task({ notePath: 'a.md', astPath: [2], updatedAt: 200 })],
    })
    expect(lengths.slice(renders)).not.toContain(1)
    expect(lengths.at(-1)).toBe(0)
  })

  it('is scoped to a graph root — switching graphs yields an empty set', async () => {
    const { result, rerender } = await renderHookInApp(
      ({ root }: { root: string } = { root: '/g' }) => useRecentlyCompleted(root, undefined),
      { core, initialProps: { root: '/g' } },
    )
    await act(() => tasks.markRecentlyCompleted('/g', [task({ notePath: 'a.md', astPath: [2] })]))
    expect(result.current).toHaveLength(1)

    await rerender({ root: '/other' })
    expect(result.current).toEqual([])

    // Completing in the other graph discards the first graph's set entirely.
    await act(() => {
      tasks.markRecentlyCompleted('/other', [task({ notePath: 'z.md', astPath: [2] })])
    })
    expect(result.current).toHaveLength(1)
    await rerender({ root: '/g' })
    expect(result.current).toEqual([])
  })
})
