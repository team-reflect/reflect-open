import { useState, useSyncExternalStore } from 'react'
import { render, cleanup } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  TaskStore,
  indexedTaskKey,
  inlineMarkdownToDisplayText,
  projectTasks,
  type Task,
} from '@reflect/core'
import '@/test-utils/locator.ts'
import { TaskEditor } from './task-editor.tsx'
import { continueFrom } from '@/lib/tasks/task-navigation.ts'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/task-editor-test', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: false,
      editorSmoothCaretAnimation: false,
      timeFormat: '24h',
    },
  }),
}))
vi.mock('@/editor/use-editor-autocomplete.ts', () => ({
  useEditorAutocomplete: () => ({ onWikilinkSearch: async () => [], onTagSearch: async () => [] }),
}))
vi.mock('@/editor/use-wiki-link-navigation.ts', () => ({ useWikiLinkNavigation: () => () => {} }))
vi.mock('@/editor/use-tag-navigation.ts', () => ({ useTagNavigation: () => () => {} }))
vi.mock('@/lib/tasks/task-store.ts', () => ({ useTaskStore: () => store }))

const target = {
  notePath: 'notes/a.md',
  noteTitle: 'A',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
}
let source: string | null
/** What the index would return for `source`. */
function indexed() {
  return projectTasks(source ?? '').map((task) => ({
    ...target,
    ...task,
    key: indexedTaskKey(target.notePath, task.astPath),
    displayText: inlineMarkdownToDisplayText(task.text),
    updatedAt: 0,
  }))
}
let store: TaskStore
const write = vi.fn<(path: string, before: string | null, next: string) => Promise<void>>()
const failure = vi.fn()

beforeEach(() => {
  source = null
  write
    .mockReset()
    .mockImplementation(async (_path: string, before: string | null, next: string) => {
      if (source !== before) throw new Error('conflict')
      source = next
    })
  failure.mockReset()
  store = new TaskStore({
    read: async () => source,
    write,
    saved: () => {},
    failure,
  })
})
afterEach(cleanup)

function Harness({ initial }: { initial: Task }) {
  const [active, setActive] = useState<Task | null>(initial)
  useSyncExternalStore(store.subscribe, store.snapshot)
  const task = active && store.current(active)
  return (
    <>
      {task && (
        <TaskEditor
          key={task.key}
          task={task}
          commands={{
            continue: (from) => setActive(continueFrom(store, from, '2026-06-14')),
            complete: () => {},
            check: () => {},
            add: () => {},
            remove: () => {
              store.update(task, { gone: 'removed' })
              setActive(null)
            },
            removeEmpty: () => {
              store.update(task, { gone: 'removed' })
              setActive(null)
            },
            convert: () => {},
            schedule: () => {},
            navigate: () => {},
            cancel: () => setActive(null),
            archive: () => {},
          }}
        />
      )}
      <button type="button" onClick={() => setActive(null)}>
        Close
      </button>
    </>
  )
}

it('keeps typing inside the real editor without publishing task state until the edit ends', async () => {
  const initial = store.create({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  const version = store.snapshot()
  await userEvent.type(page.locate('.ProseMirror'), '你好，任务内容')
  expect(store.snapshot()).toBe(version)
  expect(write).not.toHaveBeenCalled()
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(source).toContain('你好，任务内容'))
  expect(write).toHaveBeenCalledOnce()
})

it('abandons an untouched placeholder without any file write', async () => {
  const initial = store.create({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await store.flush()
  expect(write).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(store.list(indexed())).toEqual([]))
})

it('continues through twenty real editor instances while the first save is blocked', async () => {
  const gate = Promise.withResolvers<void>()
  const save = write.getMockImplementation()!
  write.mockImplementationOnce(async (...args) => {
    await gate.promise
    await save(...args)
  })
  const initial = store.create({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  for (let index = 0; index < 20; index++) {
    await userEvent.type(page.locate('.ProseMirror'), `task ${index}`)
    await userEvent.keyboard('{Enter}')
  }
  expect(store.list(indexed())).toHaveLength(21)
  gate.resolve()
  await store.flush()
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  expect(source?.match(/\+ \[ \]/g)).toHaveLength(20)
  await vi.waitFor(() => expect(store.list(indexed())).toHaveLength(20))
  expect(failure).not.toHaveBeenCalled()
})

it('does not submit the task when Enter confirms an IME composition', async () => {
  const initial = store.create({ ...target, breadcrumbs: [] })
  await render(<Harness initial={initial} />)
  const editor = page.locate('.ProseMirror')
  await userEvent.type(editor, '中文任务')
  const version = store.snapshot()
  editor
    .element()
    .dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  await userEvent.keyboard('{Enter}')
  expect(store.snapshot()).toBe(version)
  expect(write).not.toHaveBeenCalled()
  editor
    .element()
    .dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文任务' }))
  await userEvent.click(page.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  expect(source).toContain('中文任务')
})

it('discards the draft on Escape and deletes an emptied task', async () => {
  source = '+ [ ] keep\n'
  const row: Task = {
    ...target,
    key: 'notes/a.md#[0]',
    astPath: [0],
    text: 'keep',
    displayText: 'keep',
    checked: false,
    dueDate: null,
    breadcrumbs: [],
    updatedAt: 0,
  }
  await render(<Harness initial={row} />)
  await userEvent.type(page.locate('.ProseMirror'), ' more')
  await userEvent.keyboard('{Escape}')
  await store.flush()
  expect(write).not.toHaveBeenCalled()
})
