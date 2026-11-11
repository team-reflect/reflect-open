import { describe, expect, it } from 'vitest'
import { bindingToAccelerator, bindingToKeyEquivalent } from './accelerator.ts'

describe('bindingToKeyEquivalent', () => {
  it('maps Mod to ⌘ and lowercases letters, as UIKeyCommand expects', () => {
    expect(bindingToKeyEquivalent('Mod-k')).toEqual({ input: 'k', modifiers: ['command'] })
    expect(bindingToKeyEquivalent('Mod-Shift-A')).toEqual({
      input: 'a',
      modifiers: ['command', 'shift'],
    })
    expect(bindingToKeyEquivalent('Alt-Mod-c')).toEqual({
      input: 'c',
      modifiers: ['alternate', 'command'],
    })
    expect(bindingToKeyEquivalent('Ctrl-Mod-s')).toEqual({
      input: 's',
      modifiers: ['control', 'command'],
    })
  })

  it('keeps punctuation and digits, including a trailing literal "-"', () => {
    expect(bindingToKeyEquivalent('Mod-\\')?.input).toBe('\\')
    expect(bindingToKeyEquivalent('Mod-[')?.input).toBe('[')
    expect(bindingToKeyEquivalent('Mod-,')?.input).toBe(',')
    expect(bindingToKeyEquivalent('Mod-1')?.input).toBe('1')
    expect(bindingToKeyEquivalent('Mod--')).toEqual({ input: '-', modifiers: ['command'] })
  })

  it("names special keys in the menu plugin's vocabulary", () => {
    expect(bindingToKeyEquivalent('Mod-Enter')?.input).toBe('enter')
    expect(bindingToKeyEquivalent('Mod-ArrowUp')?.input).toBe('upArrow')
    expect(bindingToKeyEquivalent('Mod-Backspace')?.input).toBe('delete')
  })

  it('refuses keys and modifiers the menu bar cannot express', () => {
    expect(bindingToKeyEquivalent('Mod-F13')).toBeNull()
    expect(bindingToKeyEquivalent('Hyper-k')).toBeNull()
    expect(bindingToKeyEquivalent('constructor-a')).toBeNull()
  })
})

describe('bindingToAccelerator', () => {
  it('maps Mod to the platform-resolving CmdOrCtrl', () => {
    expect(bindingToAccelerator('Mod-d')).toBe('CmdOrCtrl+D')
    expect(bindingToAccelerator('Mod-Shift-p')).toBe('CmdOrCtrl+Shift+P')
    expect(bindingToAccelerator('Ctrl-Alt-x')).toBe('Ctrl+Alt+X')
  })

  it('keeps punctuation keys verbatim — muda parses the literal characters', () => {
    expect(bindingToAccelerator('Mod-[')).toBe('CmdOrCtrl+[')
    expect(bindingToAccelerator('Mod-]')).toBe('CmdOrCtrl+]')
    expect(bindingToAccelerator('Mod-\\')).toBe('CmdOrCtrl+\\')
    expect(bindingToAccelerator('Mod-,')).toBe('CmdOrCtrl+,')
    expect(bindingToAccelerator('Mod-/')).toBe('CmdOrCtrl+/')
  })

  it('treats a trailing dash as the literal "-" key, not a separator', () => {
    expect(bindingToAccelerator('Mod--')).toBe('CmdOrCtrl+-')
  })

  it('passes named keys through for muda to parse', () => {
    expect(bindingToAccelerator('Mod-Enter')).toBe('CmdOrCtrl+Enter')
  })

  it('does not read Object.prototype keys as modifiers', () => {
    expect(bindingToAccelerator('constructor-a')).toBe('constructor+A')
    expect(bindingToAccelerator('toString-a')).toBe('toString+A')
  })
})
