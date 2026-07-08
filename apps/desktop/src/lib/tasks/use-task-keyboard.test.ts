import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OpenTask } from '@reflect/core'
import { taskKey } from './task-identity'
import { type TaskActions } from './use-task-actions'
import { type TaskSelection } from './use-task-selection'
import { useTaskKeyboard } from './use-task-keyboard'

function task(over: Partial<OpenTask> = {}): OpenTask {
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    raw: '[ ] do it',
    checked: false,
    text: 'do it',
    breadcrumbs: [],
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...over,
  }
}

function makeSelection(over: Partial<TaskSelection> = {}): TaskSelection {
  return {
    selected: new Set<string>(),
    selectedCount: 0,
    isSelected: () => false,
    isSoleSelected: () => false,
    clickSelect: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    move: vi.fn(),
    extend: vi.fn(),
    activeKey: () => null,
    ...over,
  }
}

function makeActions(over: Partial<TaskActions> = {}): TaskActions {
  return {
    complete: vi.fn(),
    toggle: vi.fn(),
    remove: vi.fn(),
    edit: vi.fn(),
    checkboxToggle: vi.fn(),
    insert: vi.fn().mockResolvedValue(null),
    insertAfter: vi.fn().mockResolvedValue(null),
    editAndToggle: vi.fn(),
    schedule: vi.fn(),
    convertToBullet: vi.fn(),
    editAndConvertToBullet: vi.fn(),
    archive: vi.fn(),
    isPending: false,
    ...over,
  }
}

let root: HTMLDivElement
beforeEach(() => {
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterEach(() => {
  // Unmount each hook so its document keydown listener is removed — otherwise a
  // prior test's handler runs first, preventDefaults, and the next bails on it.
  cleanup()
  root.remove()
})

function mount(options: {
  selection?: TaskSelection
  actions?: TaskActions
  tasksByKey?: ReadonlyMap<string, OpenTask>
  orderedTasks?: OpenTask[]
  query?: string
  today?: string
}) {
  const selection = options.selection ?? makeSelection()
  const actions = options.actions ?? makeActions()
  const setQuery = vi.fn()
  const scrollToKey = vi.fn()
  const onToggleFilters = vi.fn()
  const onToggleSchedule = vi.fn()
  const onConvertToBullet = vi.fn()
  renderHook(() =>
    useTaskKeyboard({
      selection,
      actions,
      tasksByKey: options.tasksByKey ?? new Map(),
      orderedTasks: options.orderedTasks ?? [...(options.tasksByKey?.values() ?? [])],
      query: options.query ?? '',
      setQuery,
      today: options.today ?? '2026-06-15',
      rootRef: { current: root },
      scrollToKey,
      onToggleFilters,
      onToggleSchedule,
      onConvertToBullet,
    }),
  )
  return { selection, actions, setQuery, scrollToKey, onToggleFilters, onToggleSchedule, onConvertToBullet }
}

/** Let the `void insert(...).then(...)` microtask settle before asserting. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

function press(
  target: EventTarget,
  key: string,
  mods: { metaKey?: boolean; shiftKey?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

describe('useTaskKeyboard', () => {
  it('selects all on ⌘A and moves / extends with the arrows', () => {
    const { selection } = mount({})
    const a = press(root, 'a', { metaKey: true })
    expect(selection.selectAll).toHaveBeenCalled()
    expect(a.defaultPrevented).toBe(true)

    press(root, 'ArrowDown')
    expect(selection.move).toHaveBeenCalledWith(1)
    press(root, 'ArrowUp')
    expect(selection.move).toHaveBeenCalledWith(-1)
    press(root, 'ArrowDown', { shiftKey: true })
    expect(selection.extend).toHaveBeenCalledWith(1)
  })

  it('works when nothing is focused (the body is on-surface)', () => {
    const { selection } = mount({})
    press(document.body, 'a', { metaKey: true })
    expect(selection.selectAll).toHaveBeenCalled()
  })

  it('toggles the resolved selection on ⌘↵ and deletes it on ⌘⌫', () => {
    const t = task({ notePath: 'notes/a.md', markerOffset: 2 })
    const selection = makeSelection({ selected: new Set(['k']), selectedCount: 1 })
    const { actions } = mount({ selection, tasksByKey: new Map([['k', t]]) })

    press(root, 'Enter', { metaKey: true })
    expect(actions.toggle).toHaveBeenCalledWith([t]) // complete, or reopen if checked

    press(root, 'Backspace', { metaKey: true })
    expect(actions.remove).toHaveBeenCalledWith([t])
    expect(selection.clear).toHaveBeenCalled()
  })

  it('archives on ⌘⇧↵ instead of toggling', () => {
    const { actions } = mount({})
    press(root, 'Enter', { metaKey: true, shiftKey: true })
    expect(actions.archive).toHaveBeenCalled()
    expect(actions.toggle).not.toHaveBeenCalled()
  })

  it('toggles the filters menu on ⌘⇧E, even from the search box', () => {
    const input = document.createElement('input')
    root.appendChild(input)
    const { onToggleFilters } = mount({})
    press(root, 'e', { metaKey: true, shiftKey: true })
    expect(onToggleFilters).toHaveBeenCalledTimes(1)
    // Fires regardless of focus (it's a screen-level chord).
    press(input, 'e', { metaKey: true, shiftKey: true })
    expect(onToggleFilters).toHaveBeenCalledTimes(2)
  })

  it('opens the schedule calendar on ⌘⇧S only when something is selected', () => {
    const withNone = mount({ selection: makeSelection({ selectedCount: 0 }) })
    const noneEvent = press(root, 's', { metaKey: true, shiftKey: true })
    expect(withNone.onToggleSchedule).not.toHaveBeenCalled()
    expect(noneEvent.defaultPrevented).toBe(false)

    const withSel = mount({ selection: makeSelection({ selectedCount: 2 }) })
    const selEvent = press(root, 's', { metaKey: true, shiftKey: true })
    expect(withSel.onToggleSchedule).toHaveBeenCalledTimes(1)
    expect(selEvent.defaultPrevented).toBe(true)
  })

  it('converts the selection to bullets on ⌘⇧K only when something is selected', () => {
    const withNone = mount({ selection: makeSelection({ selectedCount: 0 }) })
    const noneEvent = press(root, 'k', { metaKey: true, shiftKey: true })
    expect(withNone.onConvertToBullet).not.toHaveBeenCalled()
    expect(noneEvent.defaultPrevented).toBe(false)

    const withSel = mount({ selection: makeSelection({ selectedCount: 2 }) })
    const selEvent = press(root, 'k', { metaKey: true, shiftKey: true })
    expect(withSel.onConvertToBullet).toHaveBeenCalledTimes(1)
    expect(selEvent.defaultPrevented).toBe(true)
  })

  it('backs off ⌘⇧K while the inline editor is focused (it handles convert itself)', () => {
    const editor = document.createElement('div')
    editor.setAttribute('data-task-editor', '')
    root.appendChild(editor)
    const selection = makeSelection({ selected: new Set(['k']), selectedCount: 1 })
    const { onConvertToBullet } = mount({ selection, tasksByKey: new Map([['k', task()]]) })

    press(editor, 'k', { metaKey: true, shiftKey: true })
    // The editor's own keymap flushes the draft then converts — the screen handler
    // must not also fire (that's the data-loss race Bugbot flagged).
    expect(onConvertToBullet).not.toHaveBeenCalled()
  })

  it('plain ⌫ removes a single empty row and selects the previous (V1)', () => {
    const a = task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first' })
    const empty = task({ notePath: 'notes/b.md', markerOffset: 2, text: '' })
    const selection = makeSelection({
      selected: new Set(['b']),
      selectedCount: 1,
      activeKey: () => 'b',
    })
    const ordered = [a, empty]
    const { actions } = mount({
      selection,
      orderedTasks: ordered,
      tasksByKey: new Map([
        ['a', a],
        ['b', empty],
      ]),
    })

    press(root, 'Backspace')
    expect(actions.remove).toHaveBeenCalledWith([empty])
    // Lands on the previous row so the keyboard flow continues.
    expect(selection.clickSelect).toHaveBeenCalledWith(taskKey(a), {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
    })
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', () => {
    const empty = task({ notePath: 'notes/a.md', markerOffset: 2, text: '' })
    const full = task({ notePath: 'notes/b.md', markerOffset: 2, text: 'keep' })
    const selection = makeSelection({ selected: new Set(['e', 'f']), selectedCount: 2 })
    const { actions } = mount({
      selection,
      tasksByKey: new Map([
        ['e', empty],
        ['f', full],
      ]),
    })

    press(root, 'Backspace')
    expect(actions.remove).not.toHaveBeenCalled()
  })

  it('Escape clears the selection and the search query together (V1)', () => {
    const { selection, setQuery } = mount({
      selection: makeSelection({ selectedCount: 1 }),
      query: 'milk',
    })
    press(root, 'Escape')
    expect(selection.clear).toHaveBeenCalled()
    expect(setQuery).toHaveBeenCalledWith('')
  })

  it('leaves Escape for other handlers when nothing is selected and the query is empty', () => {
    const { selection } = mount({ selection: makeSelection({ selectedCount: 0 }), query: '' })
    const event = press(root, 'Escape')
    expect(event.defaultPrevented).toBe(false)
    expect(selection.clear).not.toHaveBeenCalled()
  })

  it('ignores keys a focused widget already handled (defaultPrevented)', () => {
    const { selection } = mount({})
    const event = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    event.preventDefault() // a portaled menu handled it first
    act(() => {
      root.dispatchEvent(event)
    })
    expect(selection.selectAll).not.toHaveBeenCalled()
  })

  it('ignores keys from a portaled overlay (the filters menu)', () => {
    const { selection } = mount({})
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('div')
    menu.appendChild(item)
    document.body.appendChild(menu)
    press(item, 'a', { metaKey: true })
    expect(selection.selectAll).not.toHaveBeenCalled()
    menu.remove()
  })

  it('backs off when focus is outside the Tasks surface (the workspace sidebar)', () => {
    const { selection } = mount({})
    // A focused control in another panel keeps its own keys — the shortcuts must
    // not reach across to the task list. (The surface is focused on mount, so the
    // shortcuts still work the moment you're on Tasks; see the body test above.)
    const sidebarButton = document.createElement('button')
    document.body.appendChild(sidebarButton)
    press(sidebarButton, 'a', { metaKey: true })
    expect(selection.selectAll).not.toHaveBeenCalled()
    sidebarButton.remove()
  })

  it('Return adds a task to today’s daily when nothing is selected', async () => {
    const created = task({ notePath: 'daily/2026-06-15.md', markerOffset: 0, text: '' })
    const insert = vi.fn().mockResolvedValue(created)
    const { selection } = mount({ actions: makeActions({ insert }), today: '2026-06-15' })

    const event = press(root, 'Enter')
    expect(event.defaultPrevented).toBe(true)
    expect(insert).toHaveBeenCalledWith({
      notePath: 'daily/2026-06-15.md',
      noteTitle: '2026-06-15',
      dailyDate: '2026-06-15',
      isPinned: false,
      pinnedOrder: null,
    })
    await flush()
    expect(selection.clickSelect).toHaveBeenCalledWith(taskKey(created), {
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
    })
  })

  it('Return adds to the active selected row’s note, not whichever renders last', () => {
    const pinned = task({
      notePath: 'notes/a.md',
      noteTitle: 'A',
      dailyDate: null,
      isPinned: true,
      pinnedOrder: 3,
    })
    const other = task({ notePath: 'notes/z.md', noteTitle: 'Z' })
    const insert = vi.fn().mockResolvedValue(null)
    // Two notes selected; the pivot ('a') is the row last touched even though 'z'
    // renders later — the new task must join 'a', not 'z'.
    const selection = makeSelection({
      selected: new Set(['a', 'z']),
      selectedCount: 2,
      activeKey: () => 'a',
    })
    mount({
      selection,
      actions: makeActions({ insert }),
      tasksByKey: new Map([
        ['a', pinned],
        ['z', other],
      ]),
    })

    press(root, 'Enter')
    expect(insert).toHaveBeenCalledWith({
      notePath: 'notes/a.md',
      noteTitle: 'A',
      dailyDate: null,
      isPinned: true,
      pinnedOrder: 3,
    })
  })

  it('Return falls to today’s daily when the pivot is no longer selected', () => {
    const deselected = task({ notePath: 'notes/a.md', noteTitle: 'A' })
    const insert = vi.fn().mockResolvedValue(null)
    // The pivot still points at 'k' (last touched), but a ⌘-click deselected it —
    // nothing is selected now, so Return adds to today's daily, not 'k'.
    const selection = makeSelection({
      selected: new Set(),
      selectedCount: 0,
      activeKey: () => 'k',
    })
    mount({
      selection,
      actions: makeActions({ insert }),
      today: '2026-06-15',
      tasksByKey: new Map([['k', deselected]]),
    })

    press(root, 'Enter')
    expect(insert).toHaveBeenCalledWith({
      notePath: 'daily/2026-06-15.md',
      noteTitle: '2026-06-15',
      dailyDate: '2026-06-15',
      isPinned: false,
      pinnedOrder: null,
    })
  })

  it('backs off entirely while the inline editor is focused', () => {
    const editor = document.createElement('div')
    editor.setAttribute('data-task-editor', '')
    root.appendChild(editor)
    const selection = makeSelection({ selected: new Set(['k']), selectedCount: 1 })
    const { actions } = mount({ selection, tasksByKey: new Map([['k', task()]]) })

    press(editor, 'Backspace', { metaKey: true })
    press(editor, 'a', { metaKey: true })
    expect(actions.remove).not.toHaveBeenCalled()
    expect(selection.selectAll).not.toHaveBeenCalled()
  })

  it('in the search box, only Escape acts', () => {
    const input = document.createElement('input')
    root.appendChild(input)
    const { selection, setQuery } = mount({ selection: makeSelection({ selectedCount: 1 }) })

    press(input, 'a', { metaKey: true })
    expect(selection.selectAll).not.toHaveBeenCalled()

    press(input, 'Escape')
    expect(setQuery).toHaveBeenCalledWith('')
    expect(selection.clear).toHaveBeenCalled()
  })
})
