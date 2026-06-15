import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type OpenTask } from '@reflect/core'
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
    ...over,
  }
}

function makeActions(over: Partial<TaskActions> = {}): TaskActions {
  return {
    complete: vi.fn(),
    remove: vi.fn(),
    edit: vi.fn(),
    editAndComplete: vi.fn(),
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
  query?: string
}) {
  const selection = options.selection ?? makeSelection()
  const actions = options.actions ?? makeActions()
  const setQuery = vi.fn()
  renderHook(() =>
    useTaskKeyboard({
      rootRef: { current: root },
      selection,
      actions,
      tasksByKey: options.tasksByKey ?? new Map(),
      query: options.query ?? '',
      setQuery,
    }),
  )
  return { selection, actions, setQuery }
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

  it('completes the resolved selection on ⌘↵ and deletes it on ⌘⌫', () => {
    const t = task({ notePath: 'notes/a.md', markerOffset: 2 })
    const selection = makeSelection({ selected: new Set(['k']), selectedCount: 1 })
    const { actions } = mount({ selection, tasksByKey: new Map([['k', t]]) })

    press(root, 'Enter', { metaKey: true })
    expect(actions.complete).toHaveBeenCalledWith([t])

    press(root, 'Backspace', { metaKey: true })
    expect(actions.remove).toHaveBeenCalledWith([t])
    expect(selection.clear).toHaveBeenCalled()
  })

  it('plain ⌫ removes only the empty rows in the selection', () => {
    const empty = task({ notePath: 'notes/a.md', text: '' })
    const full = task({ notePath: 'notes/b.md', text: 'keep' })
    const selection = makeSelection({ selected: new Set(['e', 'f']), selectedCount: 2 })
    const { actions } = mount({
      selection,
      tasksByKey: new Map([
        ['e', empty],
        ['f', full],
      ]),
    })

    press(root, 'Backspace')
    expect(actions.remove).toHaveBeenCalledWith([empty])
  })

  it('Escape clears a selection, else clears the search query', () => {
    const withSelection = mount({ selection: makeSelection({ selectedCount: 1 }) })
    press(root, 'Escape')
    expect(withSelection.selection.clear).toHaveBeenCalled()
    expect(withSelection.setQuery).not.toHaveBeenCalled()

    const withQuery = mount({ selection: makeSelection({ selectedCount: 0 }), query: 'milk' })
    press(root, 'Escape')
    expect(withQuery.setQuery).toHaveBeenCalledWith('')
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

  it('ignores keys from outside the Tasks surface (a portaled overlay)', () => {
    const { selection } = mount({})
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    press(outside, 'a', { metaKey: true })
    expect(selection.selectAll).not.toHaveBeenCalled()
    outside.remove()
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
