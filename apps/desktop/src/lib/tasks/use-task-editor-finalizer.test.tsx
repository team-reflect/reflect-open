import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTaskEditorFinalizer } from './use-task-editor-finalizer'

function setup(initial = 'milk') {
  const onCommit = vi.fn()
  const onContinue = vi.fn()
  const onDelete = vi.fn()
  const onDeleteEmpty = vi.fn()
  const onCancel = vi.fn()
  const onComplete = vi.fn()
  const onCheckboxToggle = vi.fn()
  const onConvertToBullet = vi.fn()
  const onFlush = vi.fn()
  const { result, unmount } = renderHook(() =>
    useTaskEditorFinalizer({
      initial,
      onCommit,
      onContinue,
      onDelete,
      onDeleteEmpty,
      onCancel,
      onComplete,
      onCheckboxToggle,
      onConvertToBullet,
      onFlush,
    }),
  )
  const api = () => result.current.apiRef.current
  const type = (markdown: string) => result.current.onChange(markdown)
  return {
    api,
    type,
    unmount,
    onCommit,
    onContinue,
    onDelete,
    onDeleteEmpty,
    onCancel,
    onComplete,
    onCheckboxToggle,
    onConvertToBullet,
    onFlush,
  }
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

  it('Escape keeps a typed row but removes an empty one; ⌘⌫ always deletes', () => {
    // Typed content → Escape discards the unsaved edit but keeps the task. The
    // decision is the live editor content, not the row's (stale) projected text.
    const typed = setup('milk')
    typed.type('edited but escaped')
    typed.api().cancel()
    expect(typed.onCancel).toHaveBeenCalled()
    expect(typed.onDelete).not.toHaveBeenCalled()
    expect(typed.onCommit).not.toHaveBeenCalled()

    // An empty editor (a Return-to-add row never typed into) → Escape removes the
    // line rather than leaving a blank task.
    const empty = setup('')
    empty.api().cancel()
    expect(empty.onDelete).toHaveBeenCalled()
    expect(empty.onCancel).not.toHaveBeenCalled()

    // A task cleared to empty then escaped → also removed.
    const cleared = setup('milk')
    cleared.type('   ')
    cleared.api().cancel()
    expect(cleared.onDelete).toHaveBeenCalled()

    // ⌘⌫ deletes outright regardless of content.
    const deleted = setup('milk')
    deleted.type('still here')
    deleted.api().delete()
    expect(deleted.onDelete).toHaveBeenCalled()
  })

  it('Enter (continue) hands the screen the resolved content to persist then insert', () => {
    const changed = setup('milk')
    changed.type('oat milk')
    changed.api().commitAndContinue()
    expect(changed.onContinue).toHaveBeenCalledWith('oat milk')

    const unchanged = setup('milk')
    unchanged.api().commitAndContinue()
    expect(unchanged.onContinue).toHaveBeenCalledWith(null) // don't rewrite the row

    const emptied = setup('milk')
    emptied.type('   ')
    emptied.api().commitAndContinue()
    expect(emptied.onContinue).toHaveBeenCalledWith('')
  })

  it('Backspace on an empty row routes to delete-and-select-previous, not plain delete', () => {
    const h = setup('')
    h.api().deleteEmpty()
    expect(h.onDeleteEmpty).toHaveBeenCalled()
    expect(h.onDelete).not.toHaveBeenCalled()
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

  it('checkbox toggles: unchanged toggles, a change saves first, emptied deletes', () => {
    const unchanged = setup('milk')
    unchanged.api().checkboxToggle()
    expect(unchanged.onCheckboxToggle).toHaveBeenCalledWith(null)

    const changed = setup('milk')
    changed.type('oat milk')
    changed.api().checkboxToggle()
    expect(changed.onCheckboxToggle).toHaveBeenCalledWith('oat milk')

    const emptied = setup('milk')
    emptied.type('   ')
    emptied.api().checkboxToggle()
    expect(emptied.onDelete).toHaveBeenCalled()
    expect(emptied.onCheckboxToggle).not.toHaveBeenCalled()
  })

  it('converts to a bullet: unchanged converts as-is, a change saves first, emptied deletes', () => {
    const unchanged = setup('milk')
    unchanged.api().convertToBullet()
    expect(unchanged.onConvertToBullet).toHaveBeenCalledWith(null)

    const changed = setup('milk')
    changed.type('oat milk')
    changed.api().convertToBullet()
    expect(changed.onConvertToBullet).toHaveBeenCalledWith('oat milk')

    const emptied = setup('milk')
    emptied.type('   ')
    emptied.api().convertToBullet()
    expect(emptied.onDelete).toHaveBeenCalled()
    expect(emptied.onConvertToBullet).not.toHaveBeenCalled()
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
          onContinue: vi.fn(),
          onDelete: vi.fn(),
          onDeleteEmpty: vi.fn(),
          onCancel: vi.fn(),
          onComplete: vi.fn(),
          onCheckboxToggle: vi.fn(),
          onConvertToBullet: vi.fn(),
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
