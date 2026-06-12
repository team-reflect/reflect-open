import { describe, expect, it } from 'vitest'
import { bindingToAccelerator } from './accelerator'

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
})
