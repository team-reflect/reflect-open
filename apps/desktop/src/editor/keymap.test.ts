import { defineEditorExtension, docToMarkdown, markdownToDoc, type TypedEditor } from '@meowdown/core'
import { createEditor, union } from '@prosekit/core'
import { TextSelection, type EditorState } from '@prosekit/pm/state'
import { describe, expect, it } from 'vitest'
import { EDITOR_BINDINGS, defineReflectKeymap, listRegisteredBindings, registerKeymap } from './keymap'

function stateWithSelection(markdown: string, from: number, to: number): EditorState {
  const editor = createEditor({ extension: union(defineEditorExtension(), defineReflectKeymap()) })
  editor.setContent(markdownToDoc(editor as unknown as TypedEditor, markdown))
  return editor.state.apply(
    editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)),
  )
}

function runBinding(state: EditorState, key: string): string {
  const command = EDITOR_BINDINGS[key]
  let next = state
  expect(command(state, (tr) => (next = state.apply(tr)), undefined)).toBe(true)
  return docToMarkdown(next.doc).replace(/\n$/, '')
}

describe('keymap registry', () => {
  it('rejects duplicate bindings across scopes', () => {
    expect(() => registerKeymap('app', { 'Mod-b': 'collides' })).toThrow(/duplicate keybinding/)
  })

  it('registers all-or-nothing: a colliding batch commits no keys', () => {
    expect(() =>
      registerKeymap('app', { 'Mod-zz-unique': 'fine', 'Mod-b': 'collides' }),
    ).toThrow(/duplicate keybinding/)
    expect(listRegisteredBindings().has('Mod-zz-unique')).toBe(false)
    expect(listRegisteredBindings().get('Mod-b')).toBe('editor') // untouched
  })

  it('holds the editor bindings exactly once', () => {
    const bindings = listRegisteredBindings()
    expect(bindings.get('Mod-b')).toBe('editor')
    expect(bindings.get('Mod-i')).toBe('editor')
    expect(bindings.get('Mod-e')).toBe('editor')
  })
})

describe('inline marker toggling', () => {
  // Doc positions: paragraph starts at 1, so "hello world" spans 1..12.
  it('wraps the selection in markers', () => {
    expect(runBinding(stateWithSelection('hello world', 1, 6), 'Mod-b')).toBe('**hello** world')
    expect(runBinding(stateWithSelection('hello world', 1, 6), 'Mod-i')).toBe('_hello_ world')
    expect(runBinding(stateWithSelection('hello world', 7, 12), 'Mod-e')).toBe('hello `world`')
  })

  it('unwraps an already-wrapped selection', () => {
    // "**hello** world" — "hello" sits at 3..8 between the markers.
    expect(runBinding(stateWithSelection('**hello** world', 3, 8), 'Mod-b')).toBe('hello world')
  })

  it('inserts a marker pair at an empty selection', () => {
    expect(runBinding(stateWithSelection('hello ', 7, 7), 'Mod-b')).toBe('hello ****')
  })
})

describe('heading toggles', () => {
  it('sets and unsets the block heading level', () => {
    expect(runBinding(stateWithSelection('hello', 2, 2), 'Mod-1')).toBe('# hello')
    expect(runBinding(stateWithSelection('# hello', 2, 2), 'Mod-1')).toBe('hello')
    expect(runBinding(stateWithSelection('# hello', 2, 2), 'Mod-2')).toBe('## hello')
    expect(runBinding(stateWithSelection('hello', 2, 2), 'Mod-3')).toBe('### hello')
    expect(runBinding(stateWithSelection('### hello', 2, 2), 'Mod-3')).toBe('hello')
  })
})
