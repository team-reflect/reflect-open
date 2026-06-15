import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTaskEditorFinalizer } from './use-task-editor-finalizer'

function setup(initial = 'milk') {
  const onCommit = vi.fn()
  const onDelete = vi.fn()
  const onCancel = vi.fn()
  const onComplete = vi.fn()
  const onFlush = vi.fn()
  const { result, unmount } = renderHook(() =>
    useTaskEditorFinalizer({ initial, onCommit, onDelete, onCancel, onComplete, onFlush }),
  )
  const api = () => result.current.apiRef.current
  const type = (markdown: string) => result.current.onChange(markdown)
  return { api, type, unmount, onCommit, onDelete, onCancel, onComplete, onFlush }
}

describe('useTaskEditorFinalizer', () => {
  it('commits a real change, cancels an unchanged one, deletes an emptied one', () => {
    const changed = setup('milk')
    changed.type('oat milk')
    changed.api().commit()
    expect(changed.onCommit).toHaveBeenCalledWith('oat milk')

    const unchanged = setup('milk')
    unchanged.type('  milk ') // whitespace-only diff
    unchanged.api().commit()
    expect(unchanged.onCancel).toHaveBeenCalled()
    expect(unchanged.onCommit).not.toHaveBeenCalled()

    const emptied = setup('milk')
    emptied.type('')
    emptied.api().commit()
    expect(emptied.onDelete).toHaveBeenCalled()
  })

  it('Escape cancels and ⌘⌫ deletes regardless of content', () => {
    const escaped = setup('milk')
    escaped.type('edited but escaped')
    escaped.api().cancel()
    expect(escaped.onCancel).toHaveBeenCalled()
    expect(escaped.onCommit).not.toHaveBeenCalled()

    const deleted = setup('milk')
    deleted.type('still here')
    deleted.api().delete()
    expect(deleted.onDelete).toHaveBeenCalled()
  })

  it('completes: unchanged toggles, a change saves first, emptied deletes', () => {
    const unchanged = setup('milk')
    unchanged.api().complete()
    expect(unchanged.onComplete).toHaveBeenCalledWith(null)

    const changed = setup('milk')
    changed.type('oat milk')
    changed.api().complete()
    expect(changed.onComplete).toHaveBeenCalledWith('oat milk')

    const emptied = setup('milk')
    emptied.type('   ')
    emptied.api().complete()
    expect(emptied.onDelete).toHaveBeenCalled()
    expect(emptied.onComplete).not.toHaveBeenCalled()
  })

  it('unmount persists a change via onFlush — never cancels/clears the new selection', () => {
    const changed = setup('milk')
    changed.type('oat milk')
    changed.unmount()
    expect(changed.onFlush).toHaveBeenCalledWith('oat milk')
    expect(changed.onCancel).not.toHaveBeenCalled()
    expect(changed.onCommit).not.toHaveBeenCalled()
  })

  it('unmount of an unchanged editor does nothing (no cancel, no write)', () => {
    const unchanged = setup('milk')
    unchanged.unmount()
    expect(unchanged.onFlush).not.toHaveBeenCalled()
    expect(unchanged.onCancel).not.toHaveBeenCalled()
  })

  it('unmount persists a cleared edit (onFlush with empty content), not drops it', () => {
    const emptied = setup('milk')
    emptied.type('   ')
    emptied.unmount()
    expect(emptied.onFlush).toHaveBeenCalledWith('')
  })

  it('is single-shot: a committed editor does not also flush on unmount', () => {
    const h = setup('milk')
    h.type('oat milk')
    h.api().commit()
    h.unmount()
    expect(h.onCommit).toHaveBeenCalledTimes(1)
    expect(h.onFlush).not.toHaveBeenCalled()
  })

  it('unmount flush uses the latest render’s callback, not the mount-time one', () => {
    const onFlushA = vi.fn()
    const onFlushB = vi.fn()
    const { result, rerender, unmount } = renderHook(
      (props: { onFlush: (content: string) => void }) =>
        useTaskEditorFinalizer({
          initial: 'milk',
          onCommit: vi.fn(),
          onDelete: vi.fn(),
          onCancel: vi.fn(),
          onComplete: vi.fn(),
          onFlush: props.onFlush,
        }),
      { initialProps: { onFlush: onFlushA } },
    )
    result.current.onChange('oat milk')
    rerender({ onFlush: onFlushB }) // e.g. the row re-rendered with a fresh closure
    unmount()
    expect(onFlushB).toHaveBeenCalledWith('oat milk')
    expect(onFlushA).not.toHaveBeenCalled()
  })
})
