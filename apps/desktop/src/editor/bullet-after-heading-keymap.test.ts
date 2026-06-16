import { describe, expect, it } from 'vitest'
import { createEditor } from '@prosekit/core'
import { EditorState, TextSelection } from '@prosekit/pm/state'
import { defineEditorExtension, docToMarkdown, markdownToDoc } from '@meowdown/core'
import { bulletAfterHeadingOnEnter } from './bullet-after-heading-keymap'

/**
 * The command runs against editor state directly (no mounted view), so these
 * pin the exact doc + selection it produces for Enter-at-end-of-heading and the
 * cases it must leave alone.
 */

const editor = createEditor({ extension: defineEditorExtension() })

/** A state holding `md`, with the caret at `pos(doc)`. */
function stateAt(markdown: string, pos: (doc: ReturnType<typeof markdownToDoc>) => number): EditorState {
  const doc = markdownToDoc(markdown, editor.nodes)
  const base = EditorState.create({ schema: editor.schema, doc })
  return base.apply(base.tr.setSelection(TextSelection.create(doc, pos(doc))))
}

/** Run the command, returning whether it handled Enter and the resulting state. */
function run(state: EditorState, enabled = true): { handled: boolean; next: EditorState } {
  const command = bulletAfterHeadingOnEnter(() => enabled)
  let next = state
  const handled = command(state, (tr) => {
    next = state.apply(tr)
  })
  return { handled, next }
}

const endOfHeading = (doc: ReturnType<typeof markdownToDoc>): number => doc.child(0).nodeSize - 1

describe('bulletAfterHeadingOnEnter', () => {
  it('inserts an empty bullet after the heading and drops the caret inside it', () => {
    const { handled, next } = run(stateAt('# Title\n', endOfHeading))

    expect(handled).toBe(true)
    expect(next.doc.childCount).toBe(2)
    expect(next.doc.child(0).type.name).toBe('heading')

    const list = next.doc.child(1)
    expect(list.type.name).toBe('list')
    expect(list.attrs['kind']).toBe('bullet')
    expect(list.childCount).toBe(1)
    expect(list.child(0).type.name).toBe('paragraph')
    expect(list.child(0).content.size).toBe(0)

    // The caret sits inside the new empty bullet's paragraph.
    expect(next.selection.empty).toBe(true)
    expect(next.selection.$from.parent.type.name).toBe('paragraph')
    expect(next.selection.$from.node(-1).type.name).toBe('list')

    // The heading text is untouched; the empty bullet adds nothing to markdown.
    expect(docToMarkdown(next.doc).startsWith('# Title')).toBe(true)
  })

  it('inserts the bullet between the heading and the content that follows it', () => {
    const { handled, next } = run(stateAt('# Title\n\nbody\n', endOfHeading))

    expect(handled).toBe(true)
    expect(next.doc.childCount).toBe(3)
    expect(next.doc.child(1).type.name).toBe('list')
    expect(next.doc.child(2).type.name).toBe('paragraph')
  })

  it('does nothing when the setting is off', () => {
    const { handled, next } = run(stateAt('# Title\n', endOfHeading), false)

    expect(handled).toBe(false)
    expect(next.doc.childCount).toBe(1)
  })

  it('ignores Enter in the middle of a heading', () => {
    const { handled } = run(stateAt('# Title\n', () => 3))

    expect(handled).toBe(false)
  })

  it('ignores Enter outside a heading', () => {
    const { handled } = run(stateAt('# Title\n\nbody\n', (doc) => doc.content.size - 1))

    expect(handled).toBe(false)
  })
})
