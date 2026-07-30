import React from 'react'

/**
 * ShortcutKey — Reflect renders keyboard shortcuts as small, low-contrast
 * keycaps (⌘K, mod+shift+d). Pass a shortcut string; `mod` becomes ⌘ on
 * Apple, Ctrl elsewhere. `ghost` is the faint inline style used inside the
 * search field.
 */
export function ShortcutKey({ shortcut = '', apple = true, ghost = false, style = {} }) {
  const symbols = {
    mod: apple ? '⌘' : 'Ctrl',
    shift: '⇧',
    alt: apple ? '⌥' : 'Alt',
    meta: '⌘',
    enter: '↩',
    ctrl: 'Ctrl',
  }
  const keys = shortcut.split('+').map((k) => symbols[k.toLowerCase()] ?? k.toUpperCase())

  const cap = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 18,
    height: 18,
    padding: '0 4px',
    fontFamily: 'var(--font-sans)',
    fontSize: 11,
    fontWeight: 'var(--weight-medium)',
    lineHeight: 1,
    color: 'var(--text-muted)',
    background: ghost ? 'transparent' : 'var(--coolgray-100)',
    border: ghost ? 'none' : '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
  }

  return (
    <span style={{ display: 'inline-flex', gap: 3, ...style }}>
      {keys.map((k, i) => (
        <kbd key={i} style={cap}>
          {k}
        </kbd>
      ))}
    </span>
  )
}
