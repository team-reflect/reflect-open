import { createEditor } from '@prosekit/core'
import { defineEditorExtension, markdownToDoc, type EditorExtensionOptions } from '@meowdown/core'
import { describe, expect, it, vi } from 'vitest'
import type { EditorState } from 'prosemirror-state'
import { NoteFindQuery } from './note-find-query'

function stateFor(markdown: string, options?: EditorExtensionOptions): EditorState {
  const editor = createEditor({ extension: defineEditorExtension(options) })
  editor.setContent(markdownToDoc(markdown, { nodes: editor.nodes }))
  const container = document.createElement('div')
  document.body.append(container)
  editor.mount(container)
  const state = editor.state
  editor.unmount()
  container.remove()
  return state
}

function matchingSource(
  state: EditorState,
  queryText: string,
  options?: ConstructorParameters<typeof NoteFindQuery>[1],
): string | null {
  const result = new NoteFindQuery(queryText, options).findNext(state)
  return result === null ? null : state.doc.textBetween(result.from, result.to)
}

describe('NoteFindQuery', () => {
  it('searches displayed prose while ignoring hidden Markdown and link destinations', () => {
    const state = stateFor('Hello **bold** and [label](https://example.com)')

    expect(matchingSource(state, 'hello bold')).toBe('Hello **bold')
    expect(matchingSource(state, 'label')).toBe('label')
    expect(matchingSource(state, '**')).toBeNull()
    expect(matchingSource(state, 'https://example.com')).toBeNull()
  })

  it('matches wiki links by their visible alias and selects the whole atom', () => {
    const state = stateFor('see [[target|Shown label]] and [[Bare]]')

    expect(matchingSource(state, 'shown label')).toBe('[[target|Shown label]]')
    expect(matchingSource(state, 'target')).toBeNull()
    expect(matchingSource(state, 'bare')).toBe('[[Bare]]')
  })

  it('searches the visible labels of images, file pills, and math atoms', () => {
    const state = stateFor('![Diagram](diagram.png) [report.pdf](files/report.pdf) $x+y$', {
      resolveFileLink: () => true,
    })

    expect(matchingSource(state, 'diagram')).toBe('![Diagram](diagram.png)')
    expect(matchingSource(state, 'report.pdf')).toBe('[report.pdf](files/report.pdf)')
    expect(matchingSource(state, 'x+y')).toBe('$x+y$')
  })

  it('is case-insensitive and returns matches in document order', () => {
    const state = stateFor('Alpha alpha ALPHA')
    const query = new NoteFindQuery('alpha')
    const matches = []
    let cursor = 0
    for (;;) {
      const result = query.findNext(state, cursor)
      if (result === null) {
        break
      }
      matches.push(state.doc.textBetween(result.from, result.to))
      cursor = result.to
    }

    expect(matches).toEqual(['Alpha', 'alpha', 'ALPHA'])
  })

  it('includes visible source syntax in show mode without exposing hidden atom sources', () => {
    const state = stateFor(
      '**bold** [label](https://example.com) [[target|Alias]] ![Diagram](secret.png) $x+y$',
    )
    const show = { includeSyntax: true }

    expect(matchingSource(state, '**', show)).toBe('**')
    expect(matchingSource(state, 'https://example.com', show)).toBe('https://example.com')
    expect(matchingSource(state, 'alias', show)).toBe('[[target|Alias]]')
    expect(matchingSource(state, 'target', show)).toBeNull()
    expect(matchingSource(state, 'diagram', show)).toBe('![Diagram](secret.png)')
    expect(matchingSource(state, 'secret.png', show)).toBeNull()
    expect(matchingSource(state, '$x+y$', show)).toBe('$x+y$')
  })

  it('keeps source offsets correct after Unicode characters that expand when lowercased', () => {
    const state = stateFor('İ Alpha')

    expect(matchingSource(state, 'alpha')).toBe('Alpha')
  })

  it('uses indexed cached-result lookup with a high match count', () => {
    const matchCount = 4_096
    const state = stateFor(Array.from({ length: matchCount }, () => 'match').join(' '))
    const query = new NoteFindQuery('match')
    const first = query.findNext(state)
    const last = query.findPrev(state)
    if (first === null || last === null) {
      throw new Error('expected matches')
    }

    // Results are cached by the calls above. Looking up either edge must not
    // scan that cache again for every decoration prosemirror-search builds.
    const arrayFind = vi.spyOn(Array.prototype, 'find')
    try {
      const foundLast = query.findNext(state, last.from)
      const foundFirst = query.findPrev(state, first.to)
      const linearLookupCount = arrayFind.mock.calls.length

      expect(foundLast).toEqual(last)
      expect(foundFirst).toEqual(first)
      expect(linearLookupCount).toBe(0)
    } finally {
      arrayFind.mockRestore()
    }
  })
})
