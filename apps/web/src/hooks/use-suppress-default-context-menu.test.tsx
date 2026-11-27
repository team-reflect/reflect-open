import { afterEach, describe, expect, it } from 'vitest'
import { keepsDefaultContextMenu } from './use-suppress-default-context-menu.ts'

afterEach(() => {
  document.body.replaceChildren()
})

function mount(html: string): void {
  document.body.innerHTML = html
}

function query(selector: string): Element | null {
  return document.querySelector(selector)
}

describe('keepsDefaultContextMenu', () => {
  it('keeps the menu inside inputs and text areas', () => {
    mount('<input id="field" /><textarea id="area"></textarea>')
    expect(keepsDefaultContextMenu(query('#field'))).toBe(true)
    expect(keepsDefaultContextMenu(query('#area'))).toBe(true)
  })

  it('keeps the menu on descendants of the editor', () => {
    mount('<div class="reflect-editor"><p><strong id="word">text</strong></p></div>')
    expect(keepsDefaultContextMenu(query('#word'))).toBe(true)
  })

  it('suppresses the menu on plain chrome', () => {
    mount('<nav><button id="row">Daily</button></nav>')
    expect(keepsDefaultContextMenu(query('#row'))).toBe(false)
    expect(keepsDefaultContextMenu(document)).toBe(false)
  })
})
