import { defineEditorExtension, markdownToDoc } from '@meowdown/core'
import { createEditor, definePlugin, union } from '@prosekit/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMatchHighlights, search } from 'prosemirror-search'
import { TextSelection } from 'prosemirror-state'
import { createNoteFindController } from './note-find'

const disposals: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose()
  }
})

function findEditorFor(markdown: string) {
  const editor = createEditor({
    extension: union(defineEditorExtension(), definePlugin(search())),
  })
  editor.setContent(markdownToDoc(markdown, { nodes: editor.nodes }))
  const container = document.createElement('div')
  document.body.append(container)
  editor.mount(container)
  disposals.push(() => {
    editor.unmount()
    container.remove()
  })
  return editor
}

describe('NoteFindController', () => {
  it('starts at the caret and traverses matches with browser-style wrapping', () => {
    const editor = findEditorFor('Alpha beta alpha gamma ALPHA')
    const matches: number[] = []
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text?.toLowerCase() === 'alpha beta alpha gamma alpha') {
        matches.push(position, position + 11, position + 23)
      }
    })
    const [first, second, third] = matches
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('expected text positions')
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, second)),
    )
    const controller = createNoteFindController(editor)

    expect(controller.begin('alpha')).toEqual({ active: 2, total: 3 })
    expect(editor.state.selection.from).toBe(second)
    expect(controller.next()).toEqual({ active: 3, total: 3 })
    expect(editor.state.selection.from).toBe(third)
    expect(controller.next()).toEqual({ active: 1, total: 3 })
    expect(editor.state.selection.from).toBe(first)
    expect(controller.previous()).toEqual({ active: 3, total: 3 })

    controller.clear()
    expect(
      controller.begin('alpha', { direction: 'previous', resume: true }),
    ).toEqual({ active: 2, total: 3 })
    expect(editor.state.selection.from).toBe(second)

    controller.clear()
    expect(controller.begin('alpha', { direction: 'next', resume: true })).toEqual({
      active: 3,
      total: 3,
    })
    expect(editor.state.selection.from).toBe(third)
  })

  it('publishes query changes and clears highlights without leaving text selected', () => {
    const editor = findEditorFor('one two one')
    const controller = createNoteFindController(editor)
    const listener = vi.fn()
    const unsubscribe = controller.subscribe(listener)

    expect(controller.begin('one')).toEqual({ active: 1, total: 2 })
    expect(getMatchHighlights(editor.state).find()).toHaveLength(2)
    const activeEnd = editor.state.selection.to

    expect(controller.updateQuery('missing')).toEqual({ active: 0, total: 0 })
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(activeEnd)
    expect(controller.updateQuery('one')).toEqual({ active: 1, total: 2 })
    controller.clear()

    expect(getMatchHighlights(editor.state).find()).toHaveLength(0)
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(activeEnd)
    expect(listener).toHaveBeenLastCalledWith({ active: 0, total: 0 })

    unsubscribe()
  })

  it('searches forward from the session origin when the query changes', () => {
    const editor = findEditorFor('cat car cat')
    const controller = createNoteFindController(editor)

    expect(controller.begin('ca')).toEqual({ active: 1, total: 3 })
    expect(controller.previous()).toEqual({ active: 3, total: 3 })
    expect(controller.updateQuery('cat')).toEqual({ active: 1, total: 2 })
  })

  it('retains query changes while the editor is temporarily unbound', () => {
    const editor = findEditorFor('one two one')
    const controller = createNoteFindController(editor)
    const listener = vi.fn()
    controller.subscribe(listener)

    expect(controller.begin('one')).toEqual({ active: 1, total: 2 })
    controller.bind(undefined, 'hide')
    expect(controller.updateQuery('two')).toEqual({ active: 0, total: 0 })

    controller.bind(editor, 'hide')
    expect(listener).toHaveBeenLastCalledWith({ active: 1, total: 1 })
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe('two')

    controller.bind(undefined, 'hide')
    controller.clear()
    expect(listener).toHaveBeenLastCalledWith({ active: 0, total: 0 })

    controller.bind(editor, 'hide')
    expect(getMatchHighlights(editor.state).find()).toHaveLength(0)
    expect(editor.state.selection.empty).toBe(true)
  })

  it('searches visible Markdown source when syntax is configured to show', () => {
    const editor = findEditorFor('A [label](https://example.com)')
    const controller = createNoteFindController(editor, 'show')

    expect(controller.begin('https://example.com')).toEqual({ active: 1, total: 1 })
    expect(editor.state.doc.textBetween(
      editor.state.selection.from,
      editor.state.selection.to,
    )).toBe('https://example.com')
  })

  it('refreshes an active query when syntax visibility changes', () => {
    const editor = findEditorFor('A [label](https://example.com)')
    const controller = createNoteFindController(editor, 'hide')
    const listener = vi.fn()
    controller.subscribe(listener)

    expect(controller.begin('https://example.com')).toEqual({ active: 0, total: 0 })

    controller.bind(editor, 'show')
    expect(listener).toHaveBeenLastCalledWith({ active: 1, total: 1 })
    expect(getMatchHighlights(editor.state).find()).toHaveLength(1)

    controller.bind(editor, 'focus')
    expect(listener).toHaveBeenLastCalledWith({ active: 0, total: 0 })
    expect(getMatchHighlights(editor.state).find()).toHaveLength(0)
    expect(editor.state.selection.empty).toBe(true)

    controller.clear()
    controller.bind(editor, 'show')
    expect(getMatchHighlights(editor.state).find()).toHaveLength(0)
  })

  it('refreshes subscribers after document changes and honors unsubscribe', () => {
    const editor = findEditorFor('one two one')
    const controller = createNoteFindController(editor)
    const listener = vi.fn()

    controller.begin('one')
    const unsubscribe = controller.subscribe(listener)
    editor.view.dispatch(
      editor.state.tr.insertText(' one', editor.state.doc.content.size - 1),
    )
    controller.refresh()
    expect(listener).toHaveBeenLastCalledWith({ active: 1, total: 3 })

    unsubscribe()
    editor.view.dispatch(
      editor.state.tr.insertText(' one', editor.state.doc.content.size - 1),
    )
    controller.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('publishes the active match when the editor selection moves independently', () => {
    const editor = findEditorFor('one two one')
    const controller = createNoteFindController(editor)
    const listener = vi.fn()
    controller.subscribe(listener)

    expect(controller.begin('one')).toEqual({ active: 1, total: 2 })
    listener.mockClear()
    const [, secondMatch] = getMatchHighlights(editor.state).find()
    if (secondMatch === undefined) {
      throw new Error('expected a second match')
    }

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, secondMatch.from, secondMatch.to),
      ),
    )

    expect(listener).toHaveBeenLastCalledWith({ active: 2, total: 2 })
  })
})
