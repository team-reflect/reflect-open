import { describe, expect, it } from 'vitest'
import { formatBinding, normalizeBinding } from './keybindings.ts'

describe('formatBinding', () => {
  it('renders Apple modifier symbols', () => {
    expect(formatBinding('Mod-d', true)).toEqual(['⌘', 'D'])
    expect(formatBinding('Mod-Shift-p', true)).toEqual(['⌘', '⇧', 'P'])
    expect(formatBinding('Ctrl-Alt-x', true)).toEqual(['⌃', '⌥', 'X'])
  })

  it('renders generic modifier words elsewhere', () => {
    expect(formatBinding('Mod-d', false)).toEqual(['Ctrl', 'D'])
    expect(formatBinding('Mod-Shift-p', false)).toEqual(['Ctrl', 'Shift', 'P'])
  })

  it('treats a trailing dash as the literal "-" key, not a separator', () => {
    expect(formatBinding('Mod--', true)).toEqual(['⌘', '-'])
  })

  it('maps named keys to symbols', () => {
    expect(formatBinding('Mod-Enter', true)).toEqual(['⌘', '↩'])
    expect(formatBinding('Mod-ArrowUp', false)).toEqual(['Ctrl', '↑'])
    expect(formatBinding('Escape', true)).toEqual(['esc'])
  })

  it('keeps punctuation keys verbatim', () => {
    expect(formatBinding('Mod-\\', true)).toEqual(['⌘', '\\'])
    expect(formatBinding('Mod-,', true)).toEqual(['⌘', ','])
    expect(formatBinding('Mod-[', false)).toEqual(['Ctrl', '['])
  })

  it('a lone modifier-named final key is the key itself', () => {
    // `Mod-d` has a modifier prefix; a binding that *ends* on a modifier name
    // (nonsensical but parseable) must not render as a dangling modifier.
    expect(formatBinding('shift', true)).toEqual(['shift'])
  })
})

describe('normalizeBinding', () => {
  it('spells the platform command key Mod', () => {
    expect(normalizeBinding('Meta-1', true)).toBe('Mod-1')
    expect(normalizeBinding('Ctrl-1', false)).toBe('Mod-1')
    expect(normalizeBinding('Ctrl-1', true)).toBe('Ctrl-1')
    expect(normalizeBinding('Meta-1', false)).toBe('Meta-1')
  })

  it('puts modifiers in one order and lowercases a letter key', () => {
    expect(normalizeBinding('Alt-Mod-l', true)).toBe('Mod-Alt-l')
    expect(normalizeBinding('Shift-Alt-Mod-L', false)).toBe('Mod-Alt-Shift-l')
    expect(normalizeBinding('Shift-Mod-ArrowUp', true)).toBe('Mod-Shift-ArrowUp')
  })

  it('treats a trailing dash as the literal "-" key', () => {
    expect(normalizeBinding('Mod--', true)).toBe('Mod--')
  })

  it('rejects unknown modifiers', () => {
    expect(() => normalizeBinding('Cmd-k', true)).toThrow(/unknown modifier "Cmd"/)
  })
})
