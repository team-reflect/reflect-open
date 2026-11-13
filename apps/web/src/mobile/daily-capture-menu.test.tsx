import type { ReactElement } from 'react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createTestCoreServices, makeOpenTask, type TestCoreServices } from '@reflect/core/testing'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useDailyCapture } from './daily-capture-menu.tsx'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import {
  WritableStore,
  type MobileAudioMemoSessionState,
  type TaskService,
  type TaskWriteResult,
} from '@reflect/core'
import { MobileAudioMemoContext } from '@/mobile/audio-memo-provider.tsx'
import { act } from '@/test-utils/act.ts'

const INITIAL: MobileAudioMemoSessionState = {
  phase: 'idle',
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
  error: null,
  canRetry: false,
  drawerOpen: false,
}

const state = new WritableStore(INITIAL)
const tick = new WritableStore(0)
const actions = {
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}
const session = { get: state.get, subscribe: state.subscribe, elapsedMs: tick, level: tick }

function setMemo(patch: Partial<MobileAudioMemoSessionState>): void {
  state.set({ ...state.get(), ...patch })
}

/**
 * The result of a write that changed nothing the cache needs to re-address.
 */
const WRITTEN: TaskWriteResult = { source: '', moved: [], inserted: [], tasks: [], updatedAt: 0 }

/**
 * The empty task `insertTask` writes at the top of today's note.
 */
const INSERTED: Awaited<ReturnType<TaskService['insertTask']>> = {
  created: { astPath: [0], markdown: '', breadcrumbs: [], checked: false },
  moved: [],
  updatedAt: 0,
}

let core: TestCoreServices
let getOpenTasks: MockInstance<TaskService['getOpenTasks']>
let insertTask: MockInstance<TaskService['insertTask']>
let writeTask: MockInstance<TaskService['writeTask']>

/**
 * The quick-edit sheet, which the drawer portals outside the menu.
 */
const sheet = page.getByRole('dialog', { name: 'Edit task' })

/**
 * The open sheet's editor, once it has focus, so typing lands in it.
 */
function focusedSheetEditor(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const editor = document.querySelector<HTMLElement>('[role="dialog"] [contenteditable="true"]')
    if (editor === null) {
      throw new Error('the sheet editor is not mounted')
    }
    expect(editor.contains(document.activeElement)).toBe(true)
    return editor
  })
}

/**
 * The `+` toggle, read directly: an open modal sheet hides it from the accessibility tree.
 */
function captureToggle(view: InAppRenderResult<TestCoreServices>): HTMLButtonElement | null {
  return view.container.querySelector<HTMLButtonElement>(
    'button[aria-controls="daily-capture-actions"]',
  )
}

function DailyCaptureMenu(): ReactElement {
  const renderer = useChromeRenderer()
  const { plus, sheet } = useDailyCapture()
  return (
    <>
      <renderer.Plus plus={plus} />
      {sheet}
    </>
  )
}

function renderMenu(): Promise<InAppRenderResult<TestCoreServices>> {
  return renderInApp(
    <MobileAudioMemoContext value={{ session, ...actions }}>
      <DailyCaptureMenu />
    </MobileAudioMemoContext>,
    { core },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  state.set(INITIAL)
  core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  // Today is 2026-06-14.
  core.clock.setNow(new Date(2026, 5, 14, 12).getTime())
  getOpenTasks = vi.spyOn(core.tasks, 'getOpenTasks').mockResolvedValue([])
  insertTask = vi.spyOn(core.tasks, 'insertTask').mockResolvedValue(INSERTED)
  writeTask = vi.spyOn(core.tasks, 'writeTask').mockResolvedValue(WRITTEN)
})

describe('DailyCaptureMenu', () => {
  it('starts collapsed with only the toggle in the accessibility tree', async () => {
    const view = await renderMenu()

    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(view.getByRole('button', { name: 'New note' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'New task' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Record audio memo' }).query()).toBeNull()

    for (const label of ['New note', 'New task', 'Record audio memo']) {
      const action = view.container.querySelector<HTMLButtonElement>(
        `button[aria-label="${CSS.escape(label)}"]`,
      )
      expect(action?.tabIndex).toBe(-1)
      expect(action?.parentElement?.classList.contains('pointer-events-none')).toBe(true)
    }
  })

  it('reveals every action on the first tap and hides them on the second', async () => {
    const view = await renderMenu()

    await view.getByRole('button', { name: 'Show capture actions' }).click()
    expect(view.core.mobile.haptics.impacts()).toBe(1)

    await expect
      .element(view.getByRole('button', { name: 'Hide capture actions' }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'New task' })).toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()

    await view.getByRole('button', { name: 'Hide capture actions' }).click()
    expect(view.core.mobile.haptics.impacts()).toBe(2)

    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(view.getByRole('button', { name: 'New note' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'New task' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Record audio memo' }).query()).toBeNull()
  })

  it('animates the individual translate and scale properties', async () => {
    const view = await renderMenu()
    const newNoteAction = view.container.querySelector<HTMLElement>('[data-slot="new-note-action"]')

    if (!newNoteAction) {
      throw new Error('new-note action was not mounted')
    }
    expect(newNoteAction.className).toContain('transition-[translate,scale,opacity]')
  })

  it('creates an untitled note and collapses', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New note' }).click()

    const navigations = view.appServices.navigation.navigations()
    expect(navigations).toHaveLength(1)
    expect(navigations[0]?.route).toMatchObject({
      kind: 'note',
      path: expect.stringMatching(/^notes\/.+\.md$/) as string,
    })
    expect(navigations[0]?.options).toBeUndefined()
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it("adds a task to today's daily note and Enter saves what was typed into its sheet", async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New task' }).click()

    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md'))
    expect(captureToggle(view)?.getAttribute('aria-expanded')).toBe('false')
    // The task is brand new, so the editor has focus and typing starts at once.
    await focusedSheetEditor()

    await userEvent.keyboard('buy oat milk')
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ markdown: '' }), [
      { kind: 'setMarkdown', markdown: 'buy oat milk' },
    ])
    await expect.element(sheet).not.toBeInTheDocument()
  })

  it('edits the live row when a reindex rewrites the task while its sheet is open', async () => {
    const view = await renderMenu()
    // The Daily screen leaves the graph's task rows alone until a sheet needs them.
    core.indexLifecycle.emitApplied(null, 1)
    expect(getOpenTasks).not.toHaveBeenCalled()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()

    // Another device rewrites the task in place; the reindex re-reads the rows.
    const readsBefore = getOpenTasks.mock.calls.length
    getOpenTasks.mockResolvedValue([
      makeOpenTask({
        notePath: 'daily/2026-06-14.md',
        dailyDate: '2026-06-14',
        astPath: [0],
        markdown: 'synced from another device',
      }),
    ])
    core.indexLifecycle.emitApplied(null, 1)
    await vi.waitFor(() => expect(getOpenTasks).toHaveBeenCalledTimes(readsBefore + 1))
    await act(async () => {
      await getOpenTasks.mock.results.at(-1)?.value
    })

    await userEvent.keyboard('buy oat milk')
    await userEvent.keyboard('{Escape}')

    // The write addresses the row as it is now, so the guard matches it.
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: 'synced from another device' }),
      [{ kind: 'setMarkdown', markdown: 'buy oat milk' }],
    )
  })

  it('removes the new task when its sheet is dismissed untyped', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()

    await userEvent.keyboard('{Escape}')

    // V1's empty-task rule: a change of heart leaves no bare `+ [ ]` behind.
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(expect.anything(), [{ kind: 'remove' }])
  })

  it('adds one task when New task is tapped again before the first lands', async () => {
    const pending = Promise.withResolvers<typeof INSERTED>()
    insertTask.mockReturnValue(pending.promise)
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()

    pending.resolve(INSERTED)

    await expect.element(sheet).toBeInTheDocument()
    expect(insertTask).toHaveBeenCalledTimes(1)
  })

  it('removes a task that lands after the menu has gone', async () => {
    const pending = Promise.withResolvers<typeof INSERTED>()
    insertTask.mockReturnValue(pending.promise)
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()

    await view.unmount()
    pending.resolve(INSERTED)

    // No sheet will ever show it, so it must not stay behind as a bare `+ [ ]`.
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    expect(writeTask).toHaveBeenCalledWith(expect.anything(), [{ kind: 'remove' }])
  })

  it('removes a late task even while an earlier sheet’s delete is still pending', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()
    // The first sheet is dismissed untyped; its empty-task delete stays in flight.
    const firstDelete = Promise.withResolvers<TaskWriteResult>()
    writeTask.mockReturnValueOnce(firstDelete.promise)
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
    await expect.element(sheet).not.toBeInTheDocument()

    const pending = Promise.withResolvers<typeof INSERTED>()
    insertTask.mockReturnValueOnce(pending.promise)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await view.unmount()
    pending.resolve({ ...INSERTED, created: { ...INSERTED.created, astPath: [1] } })

    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(2))
    expect(writeTask).toHaveBeenLastCalledWith(expect.objectContaining({ astPath: [1] }), [
      { kind: 'remove' },
    ])
    firstDelete.resolve(WRITTEN)
  })

  it('opens no sheet when adding the task fails', async () => {
    insertTask.mockRejectedValue(new Error('disk full'))
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New task' }).click()

    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(core.progress.findByLabel('Adding task')?.status).toBe('failed'))
    expect(sheet.query()).toBeNull()
  })

  it('starts the audio memo and collapses', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'Record audio memo' }).click()

    expect(actions.toggle).toHaveBeenCalledTimes(1)
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the current recording, processing, and error states when reopened', async () => {
    const view = await renderMenu()

    await act(() => {
      setMemo({ phase: 'recording' })
    })
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect.element(view.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    await act(() => {
      setMemo({ phase: 'transcribing' })
    })
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }).getByTestId('spinner'))
      .toBeInTheDocument()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    await act(() => {
      setMemo({ phase: 'error', error: 'disk full' })
    })
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Show audio memo error' }))
      .toBeInTheDocument()
  })

  it('reveals New note and New task when native audio is unavailable', async () => {
    setMemo({ available: false })
    const view = await renderMenu()

    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'New task' })).toBeInTheDocument()
    expect(view.container.querySelector('[data-slot="audio-memo-action"]')).toBeNull()
  })
})
