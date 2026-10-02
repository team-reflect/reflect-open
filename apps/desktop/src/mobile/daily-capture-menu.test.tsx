import { render, type RenderResult } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { insertedTaskRow } from '@/lib/tasks/task-insert-target.ts'
import { todaysDailyTarget } from '@/lib/tasks/task-navigation.ts'
import { DailyCaptureMenu } from './daily-capture-menu.tsx'

const navigate = vi.hoisted(() => vi.fn())
const hapticImpactLight = vi.hoisted(() => vi.fn())
const memo = vi.hoisted(() => ({
  phase: 'idle' as 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error',
  elapsedMs: 0,
  level: 0,
  pendingCount: 0,
  available: true,
  hasTranscriptionConfig: true,
  error: null as string | null,
  canRetry: false,
  drawerOpen: false,
  toggle: vi.fn(),
  stopAndSave: vi.fn(),
  cancelRecording: vi.fn(),
  onDrawerOpenChange: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))
const newTask = vi.hoisted(() => ({
  start: vi.fn(),
  task: null as OpenTask | null,
  open: false,
  setOpen: vi.fn(),
  today: '2026-06-14',
  actions: {},
}))

vi.mock('@/routing/router.tsx', () => ({
  useRouter: () => ({ navigate }),
}))

vi.mock('@/mobile/audio-memo-provider.tsx', () => ({
  useMobileAudioMemo: () => ({ ...memo }),
}))

vi.mock('@/mobile/haptics.ts', () => ({
  hapticImpactLight,
}))

vi.mock('@/mobile/use-new-task-sheet.ts', () => ({
  useNewTaskSheet: () => ({ ...newTask }),
}))

// The real sheet mounts a NoteEditor inside a drawer; its own tests cover it.
vi.mock('@/mobile/task-edit-sheet.tsx', () => ({
  MobileTaskEditSheet: ({
    task,
    open,
    autoFocusEditor,
  }: {
    task: OpenTask
    open: boolean
    autoFocusEditor?: boolean
  }) =>
    open ? (
      <div
        role="dialog"
        aria-label="Edit task"
        data-note-path={task.notePath}
        data-auto-focus={String(autoFocusEditor)}
      />
    ) : null,
}))

function renderMenu(): Promise<RenderResult> {
  return render(<DailyCaptureMenu />)
}

beforeEach(() => {
  vi.clearAllMocks()
  memo.phase = 'idle'
  memo.available = true
  memo.error = null
  newTask.task = null
  newTask.open = false
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
    expect(hapticImpactLight).toHaveBeenCalledTimes(1)

    await expect
      .element(view.getByRole('button', { name: 'Hide capture actions' }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'New task' })).toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()

    await view.getByRole('button', { name: 'Hide capture actions' }).click()
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)

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

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
    )
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it("starts a task in today's note and collapses", async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'New task' }).click()

    expect(newTask.start).toHaveBeenCalledTimes(1)
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the quick-edit sheet on the new task with the editor focused', async () => {
    const view = await renderMenu()
    expect(view.getByRole('dialog', { name: 'Edit task' }).query()).toBeNull()

    newTask.task = insertedTaskRow(todaysDailyTarget('2026-06-14'), 2)
    newTask.open = true
    await view.rerender(<DailyCaptureMenu />)

    const sheet = view.getByRole('dialog', { name: 'Edit task' })
    await expect.element(sheet).toHaveAttribute('data-note-path', 'daily/2026-06-14.md')
    await expect.element(sheet).toHaveAttribute('data-auto-focus', 'true')
  })

  it('starts the audio memo and collapses', async () => {
    const view = await renderMenu()
    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await view.getByRole('button', { name: 'Record audio memo' }).click()

    expect(memo.toggle).toHaveBeenCalledTimes(1)
    await expect
      .element(view.getByRole('button', { name: 'Show capture actions' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the current recording, processing, and error states when reopened', async () => {
    const view = await renderMenu()

    memo.phase = 'recording'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect.element(view.getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    memo.phase = 'transcribing'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Record audio memo' }))
      .toBeInTheDocument()
    expect(
      view.container.querySelector('[data-slot="audio-memo-action"] .animate-spin'),
    ).not.toBeNull()
    await view.getByRole('button', { name: 'Hide capture actions' }).click()

    memo.phase = 'error'
    memo.error = 'disk full'
    await view.rerender(<DailyCaptureMenu />)
    await view.getByRole('button', { name: 'Show capture actions' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Show audio memo error' }))
      .toBeInTheDocument()
  })

  it('reveals New note and New task when native audio is unavailable', async () => {
    memo.available = false
    const view = await renderMenu()

    await view.getByRole('button', { name: 'Show capture actions' }).click()

    await expect.element(view.getByRole('button', { name: 'New note' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'New task' })).toBeInTheDocument()
    expect(view.container.querySelector('[data-slot="audio-memo-action"]')).toBeNull()
  })
})
