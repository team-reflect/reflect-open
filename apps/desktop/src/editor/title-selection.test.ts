import { defineEditorExtension, docToMarkdown, markdownToDoc, type TypedEditor } from '@meowdown/core'
import { createEditor } from '@prosekit/core'
import type { EditorState } from '@prosekit/pm/state'
import { describe, expect, it } from 'vitest'
import { firstHeadingTextRange, selectFirstHeadingText } from './title-selection'

/**
 * The new-note title selection (select "Untitled" so the first keystroke names
 * the note) against real meowdown documents — positions here are easy to get
 * subtly wrong against ProseMirror's node-boundary offsets.
 */

function stateFor(markdown: string): EditorState {
  const editor = createEditor({ extension: defineEditorExtension() })
  editor.setContent(markdownToDoc(editor as unknown as TypedEditor, markdown))
  return editor.state
}

function selectedText(state: EditorState): string {
  return state.doc.textBetween(state.selection.from, state.selection.to)
}

describe('firstHeadingTextRange', () => {
  it('finds the seeded Untitled title', () => {
    const state = stateFor('# Untitled\n')
    const range = firstHeadingTextRange(state.doc)
    expect(range).not.toBeNull()
    expect(state.doc.textBetween(range!.from, range!.to)).toBe('Untitled')
  })

  it('finds a heading that is not the first block', () => {
    const state = stateFor('intro paragraph\n\n# Actual Title\n\nbody\n')
    const range = firstHeadingTextRange(state.doc)
    expect(range).not.toBeNull()
    expect(state.doc.textBetween(range!.from, range!.to)).toBe('Actual Title')
  })

  it('returns null when the document has no heading', () => {
    expect(firstHeadingTextRange(stateFor('just a paragraph\n').doc)).toBeNull()
    expect(firstHeadingTextRange(stateFor('').doc)).toBeNull()
  })

  it('returns null for an empty heading (nothing to select)', () => {
    expect(firstHeadingTextRange(stateFor('#\n\nbody\n').doc)).toBeNull()
  })
})

describe('selectFirstHeadingText', () => {
  it('selects the title text so typing replaces it', () => {
    let state = stateFor('# Untitled\n\nbody\n')
    const handled = selectFirstHeadingText(state, (tr) => {
      state = state.apply(tr)
    })
    expect(handled).toBe(true)
    expect(selectedText(state)).toBe('Untitled')

    // The first keystroke replaces the selection — the macOS rename pattern.
    state = state.apply(state.tr.insertText('My Note'))
    expect(docToMarkdown(state.doc)).toContain('# My Note')
    expect(docToMarkdown(state.doc)).not.toContain('Untitled')
  })

  it('returns false without dispatching when there is no titled heading', () => {
    const state = stateFor('plain text\n')
    let dispatched = false
    const handled = selectFirstHeadingText(state, () => {
      dispatched = true
    })
    expect(handled).toBe(false)
    expect(dispatched).toBe(false)
  })
})
