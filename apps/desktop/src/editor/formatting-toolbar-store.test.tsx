import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearFormattingToolbar,
  publishFormattingToolbar,
  useFormattingToolbar,
  type FormattingToolbar,
} from './formatting-toolbar-store'

function makeToolbar(overrides: Partial<FormattingToolbar['capabilities']> = {}): FormattingToolbar {
  return {
    capabilities: {
      canIndent: false,
      canDedent: false,
      canMoveUp: false,
      canMoveDown: false,
      ...overrides,
    },
    commands: {
      toggleBulletList: vi.fn(),
      cycleCheckableList: vi.fn(),
      indent: vi.fn(),
      dedent: vi.fn(),
      moveUp: vi.fn(),
      moveDown: vi.fn(),
      insertTrigger: vi.fn(),
      dismissKeyboard: vi.fn(),
      scrollCaretIntoView: vi.fn(),
    },
  }
}

const owners: symbol[] = []
function makeOwner(): symbol {
  const owner = Symbol('test-owner')
  owners.push(owner)
  return owner
}

afterEach(() => {
  // The store is module-scope; release every owner a test may have left active.
  for (const owner of owners.splice(0)) {
    clearFormattingToolbar(owner)
  }
})

describe('formatting toolbar store', () => {
  it('publishes and clears the active toolbar', () => {
    const view = renderHook(() => useFormattingToolbar())
    expect(view.result.current).toBeNull()

    const owner = makeOwner()
    const toolbar = makeToolbar()
    act(() => publishFormattingToolbar(owner, toolbar))
    expect(view.result.current).toBe(toolbar)

    act(() => clearFormattingToolbar(owner))
    expect(view.result.current).toBeNull()
  })

  it('drops a refresh with equal capabilities and the same commands', () => {
    const view = renderHook(() => useFormattingToolbar())
    const owner = makeOwner()
    const toolbar = makeToolbar()
    act(() => publishFormattingToolbar(owner, toolbar))

    // A caret move that changes nothing must keep the same snapshot object,
    // so the toolbar component never re-renders for it.
    act(() =>
      publishFormattingToolbar(owner, {
        capabilities: { ...toolbar.capabilities },
        commands: toolbar.commands,
      }),
    )
    expect(view.result.current).toBe(toolbar)

    act(() =>
      publishFormattingToolbar(owner, {
        capabilities: { ...toolbar.capabilities, canIndent: true },
        commands: toolbar.commands,
      }),
    )
    expect(view.result.current).not.toBe(toolbar)
    expect(view.result.current?.capabilities.canIndent).toBe(true)
  })

  it('ignores a stale clear after another editor took over', () => {
    const view = renderHook(() => useFormattingToolbar())
    const first = makeOwner()
    const second = makeOwner()
    act(() => publishFormattingToolbar(first, makeToolbar()))

    const takeover = makeToolbar({ canIndent: true })
    act(() => publishFormattingToolbar(second, takeover))
    expect(view.result.current).toBe(takeover)

    act(() => clearFormattingToolbar(first))
    expect(view.result.current).toBe(takeover)

    act(() => clearFormattingToolbar(second))
    expect(view.result.current).toBeNull()
  })
})
