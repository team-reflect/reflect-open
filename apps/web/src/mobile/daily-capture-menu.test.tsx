import { noop } from '@ocavue/utils'
import type { ReactElement } from 'react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createTestDatabaseService,
  createTestCoreServices,
  makeOpenTask,
  TestTaskIndex,
  type TestCoreServices,
} from '@reflect/core/testing'
import { spyOnTaskWrites, type TaskWriteSpies } from '@/test-utils/task-writes.ts'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { useDailyCapture } from './daily-capture-menu.tsx'
import { useChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'
import { WritableStore, type MobileAudioMemoSessionState, type OpenTask } from '@reflect/core'
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

let core: TestCoreServices
let getOpenTasks: Mock<() => Promise<OpenTask[]>>
let insertTask: TaskWriteSpies['insertTask']
let writeTask: TaskWriteSpies['writeTask']

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
      {/* The `pad` bars put the `+` in the bottom-right corner. */}
      <renderer.ShellBars form="pad" tab="daily" keyboardVisible={false} onSelectTab={noop} />
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
  core = createTestCoreServices({ database: createTestDatabaseService() })
  // Today is 2026-06-14.
  core.clock.setNow(new Date(2026, 5, 14, 12).getTime())
  getOpenTasks = vi.fn<() => Promise<OpenTask[]>>().mockResolvedValue([])
  const taskIndex = new TestTaskIndex(core.database, getOpenTasks, () => Promise.resolve([]))
  const spies = spyOnTaskWrites(core.tasks.commands, taskIndex)
  insertTask = spies.insertTask
  writeTask = spies.writeTask
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

  it("shows a new task for today's daily note and Enter writes what was typed into its sheet", async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New task' }).click()

    expect(captureToggle(view)?.getAttribute('aria-expanded')).toBe('false')
    // The task is brand new, so the editor has focus and typing starts at once.
    await focusedSheetEditor()
    expect(insertTask).not.toHaveBeenCalled()

    await userEvent.keyboard('buy oat milk')
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() => {
      expect(insertTask.mock.calls).toEqual([
        ['daily/2026-06-14.md', { markdown: 'buy oat milk', checked: false }],
      ])
    })
    expect(writeTask).not.toHaveBeenCalled()
    await expect.element(sheet).not.toBeInTheDocument()
  })

  it('keeps the new task when a reindex lands while its sheet is open', async () => {
    const view = await renderMenu()
    // The Daily screen leaves the graph's task rows alone until a sheet needs them.
    core.ipc.emit('index:committed', { seq: 1, paths: null })
    expect(getOpenTasks).not.toHaveBeenCalled()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()

    const readsBefore = getOpenTasks.mock.calls.length
    getOpenTasks.mockResolvedValue([
      makeOpenTask({ notePath: 'notes/other.md', markdown: 'other' }),
    ])
    core.ipc.emit('index:committed', { seq: 1, paths: null })
    await vi.waitFor(() => expect(getOpenTasks).toHaveBeenCalledTimes(readsBefore + 1))
    await act(async () => {
      await getOpenTasks.mock.results.at(-1)?.value
    })

    await userEvent.keyboard('buy oat milk')
    await userEvent.keyboard('{Escape}')

    await vi.waitFor(() => {
      expect(insertTask.mock.calls).toEqual([
        ['daily/2026-06-14.md', { markdown: 'buy oat milk', checked: false }],
      ])
    })
  })

  it('writes nothing when the sheet of the new task is dismissed untyped', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()

    await userEvent.keyboard('{Escape}')

    await expect.element(sheet).not.toBeInTheDocument()
    expect(core.tasks.get().open).toEqual([])
    expect(insertTask).not.toHaveBeenCalled()
    expect(writeTask).not.toHaveBeenCalled()
  })

  it('writes what was typed when the menu goes away under the open sheet', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await view.getByRole('button', { name: 'New task' }).click()
    await focusedSheetEditor()
    await userEvent.keyboard('buy oat milk')

    await view.unmount()

    await vi.waitFor(() => {
      expect(insertTask.mock.calls).toEqual([
        ['daily/2026-06-14.md', { markdown: 'buy oat milk', checked: false }],
      ])
    })
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
