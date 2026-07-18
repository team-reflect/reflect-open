import { markdownToDoc } from '@meowdown/core'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { dailyNoteAutoTimestampPlugin } from './daily-note-auto-timestamp-plugin'

/**
 * Direct tests of the ProseMirror plugin — no editor view or DOM. Each test
 * builds a state from meowdown-parsed markdown, applies a synthetic
 * transaction through `applyTransaction` (which triggers `appendTransaction`),
 * and serializes the resulting doc to a plain assertion string. The clock is
 * injected so timestamps are deterministic.
 */

const FIXED_TIME = new Date('2026-06-25T14:30:00')
const getNow = (): Date => FIXED_TIME

function stateFromMarkdown(markdown: string): EditorState {
  const doc = markdownToDoc(markdown)
  return EditorState.create({
    doc,
    plugins: [dailyNoteAutoTimestampPlugin({ getNow })],
  })
}

function textOf(state: EditorState): string {
  const lines: string[] = []
  state.doc.forEach((child) => {
    child.forEach((grandchild) => {
      lines.push(grandchild.textContent)
    })
  })
  return lines.join('\n')
}

function withSelectionAt(state: EditorState, pos: number): EditorState {
  return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(pos))))
}

function applyTransaction(
  state: EditorState,
  build: (tr: Transaction) => Transaction | void,
): { state: EditorState; transactionCount: number } {
  const tr = state.tr
  build(tr)
  const result = state.applyTransaction(tr)
  return { state: result.state, transactionCount: result.transactions.length }
}

/**
 * Return the first content position inside the given top-level bullet's
 * paragraph. Assumes the markdown produced consecutive `list` nodes at the
 * document root (one per bullet).
 */
function positionInsideBullet(state: EditorState, bulletIndex: number): number {
  let cursor = 0
  let found: number | null = null
  state.doc.forEach((child, offset) => {
    if (child.type.name === 'list') {
      if (cursor === bulletIndex) {
        // Enter the list, then enter its first paragraph.
        found = offset + 2
      }
      cursor += 1
    }
  })
  if (found === null) {
    throw new Error(`bullet index ${bulletIndex} not found`)
  }
  return found
}

describe('dailyNoteAutoTimestampPlugin', () => {
  it('stamps the paragraph as soon as the first character lands', () => {
    const empty = stateFromMarkdown('- ')
    const state = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const bulletStart = positionInsideBullet(state, 0)
    const result = applyTransaction(state, (tr) => tr.insertText('h', bulletStart))
    expect(textOf(result.state)).toBe('`14:30` h')
    // Original insert + appended stamp.
    expect(result.transactionCount).toBe(2)
  })

  it('stamps once — subsequent typing in the same bullet leaves it alone', () => {
    const empty = stateFromMarkdown('- ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const first = applyTransaction(initial, (tr) =>
      tr.insertText('h', positionInsideBullet(initial, 0)),
    )
    expect(textOf(first.state)).toBe('`14:30` h')
    // The stamp lands before 'h' and pushes the caret with it, so we type the
    // next character at the end of the paragraph.
    const nextPos = first.state.selection.head
    const second = applyTransaction(first.state, (tr) => tr.insertText('i', nextPos))
    expect(textOf(second.state)).toBe('`14:30` hi')
    // Only the insert; no re-stamp.
    expect(second.transactionCount).toBe(1)
  })

  it('inserts the stamp on committed IME text (single transaction with multi-char)', () => {
    // ProseMirror queues DOM mutations during composition and dispatches a
    // single transaction on `compositionend` — the plugin sees empty → the
    // full committed string as one step. This mirrors the IME code path.
    const empty = stateFromMarkdown('- ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const result = applyTransaction(initial, (tr) =>
      tr.insertText('你好', positionInsideBullet(initial, 0)),
    )
    expect(textOf(result.state)).toBe('`14:30` 你好')
    expect(result.transactionCount).toBe(2)
  })

  it('does not stamp when the first character is a backtick', () => {
    // The user is typing their own code span or their own timestamp; either
    // way we stay out of the way.
    const empty = stateFromMarkdown('- ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const result = applyTransaction(initial, (tr) =>
      tr.insertText('`code`', positionInsideBullet(initial, 0)),
    )
    expect(textOf(result.state)).toBe('`code`')
    expect(result.transactionCount).toBe(1)
  })

  it('does not stamp a paragraph that already had content (no empty → non-empty)', () => {
    // Loaded content that was never stamped (legacy bullets) stays as-is when
    // the user simply edits it further. Stamping is a first-write event.
    const preloaded = stateFromMarkdown('- write plan')
    const initial = withSelectionAt(preloaded, positionInsideBullet(preloaded, 0) + 'write plan'.length)
    const result = applyTransaction(initial, (tr) =>
      tr.insertText('!', initial.selection.head),
    )
    expect(textOf(result.state)).toBe('write plan!')
    expect(result.transactionCount).toBe(1)
  })

  it('re-stamps after the paragraph is cleared and typed again', () => {
    // The transition, not the identity, is what matters — a user who backs
    // out and rewrites gets a fresh timestamp for the fresh capture.
    const empty = stateFromMarkdown('- ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const typed = applyTransaction(initial, (tr) =>
      tr.insertText('h', positionInsideBullet(initial, 0)),
    ).state
    // Clear the paragraph (delete all its content).
    const bulletStart = positionInsideBullet(typed, 0)
    const bulletEnd = typed.doc.resolve(bulletStart).end(typed.doc.resolve(bulletStart).depth)
    const cleared = typed.apply(typed.tr.delete(bulletStart, bulletEnd))
    expect(textOf(cleared)).toBe('')
    // Type again — should stamp with a fresh HH:mm (fixed clock here still).
    const retyped = applyTransaction(cleared, (tr) => tr.insertText('x', bulletStart))
    expect(textOf(retyped.state)).toBe('`14:30` x')
    expect(retyped.transactionCount).toBe(2)
  })

  it('skips task-list items (kind is not bullet)', () => {
    const empty = stateFromMarkdown('- [ ] ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const result = applyTransaction(initial, (tr) =>
      tr.insertText('chore', positionInsideBullet(initial, 0)),
    )
    expect(textOf(result.state)).toBe('chore')
    expect(result.transactionCount).toBe(1)
  })

  it('skips ordered-list items', () => {
    const empty = stateFromMarkdown('1. ')
    const initial = withSelectionAt(empty, positionInsideBullet(empty, 0))
    const result = applyTransaction(initial, (tr) =>
      tr.insertText('one', positionInsideBullet(initial, 0)),
    )
    expect(textOf(result.state)).toBe('one')
    expect(result.transactionCount).toBe(1)
  })

  it('skips plain paragraphs outside a list', () => {
    const empty = stateFromMarkdown('')
    const initial = withSelectionAt(empty, 1)
    const result = applyTransaction(initial, (tr) => tr.insertText('note', 1))
    expect(textOf(result.state)).toBe('note')
    expect(result.transactionCount).toBe(1)
  })
})
