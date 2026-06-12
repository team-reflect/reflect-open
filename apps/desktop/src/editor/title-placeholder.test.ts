import type { EditorState } from '@prosekit/pm/state'
import { DecorationSet } from '@prosekit/pm/view'
import { describe, expect, it } from 'vitest'
import { createMeowdownEditor } from './meowdown'
import { defineTitlePlaceholder, titlePlaceholderRange } from './title-placeholder'

/**
 * The new-note title placeholder against real meowdown documents: the ghost
 * must sit on exactly the seeded empty H1 — never on titled headings, body
 * blocks, or non-heading documents — and stay put while the body is written.
 */

function stateFor(markdown: string): EditorState {
  return createMeowdownEditor(markdown, defineTitlePlaceholder('Untitled')).state
}

describe('titlePlaceholderRange', () => {
  it('targets the seeded empty H1', () => {
    const { doc } = stateFor('#\n')
    expect(titlePlaceholderRange(doc)).toEqual({ from: 0, to: doc.firstChild?.nodeSize })
  })

  it('keeps the target while the body is written below the empty title', () => {
    expect(titlePlaceholderRange(stateFor('#\n\nbody underway\n').doc)).not.toBeNull()
  })

  it('clears once the title has text', () => {
    expect(titlePlaceholderRange(stateFor('# My Note\n').doc)).toBeNull()
  })

  it('ignores documents that do not lead with an empty H1', () => {
    expect(titlePlaceholderRange(stateFor('plain paragraph\n').doc)).toBeNull()
    expect(titlePlaceholderRange(stateFor('').doc)).toBeNull()
    // An empty H2 is not the title position.
    expect(titlePlaceholderRange(stateFor('##\n').doc)).toBeNull()
    // A mid-document empty heading is body structure, not the name field.
    expect(titlePlaceholderRange(stateFor('intro\n\n#\n').doc)).toBeNull()
  })
})

describe('defineTitlePlaceholder', () => {
  it('decorates the empty title through the plugin the editor mounts', () => {
    const state = stateFor('#\n')
    const decorations = state.plugins
      .map((plugin) => plugin.props.decorations?.call(plugin, state))
      .filter((set): set is DecorationSet => set instanceof DecorationSet)
      .flatMap((set) => set.find())
    const titleEnd = state.doc.firstChild?.nodeSize ?? Number.NaN
    expect(decorations.some(({ from, to }) => from === 0 && to === titleEnd)).toBe(true)
  })
})
