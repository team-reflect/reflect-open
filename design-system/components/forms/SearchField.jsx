import React from 'react'
import { ShortcutKey } from '../buttons/ShortcutKey.jsx'

/**
 * SearchField — Reflect's signature "Search anything…" trigger that lives at
 * the top of the sidebar. It's a button styled as an input: magnifier, muted
 * placeholder, and a ghost ⌘K keycap pinned to the right.
 */
export function SearchField({
  placeholder = 'Search anything…',
  shortcut = 'mod+k',
  onClick,
  className = '',
  style = {},
}) {
  const [hover, setHover] = React.useState(false)
  return (
    <div
      role="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flex: 1,
        cursor: 'text',
        background: 'var(--input-bg)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        padding: '6px 8px',
        fontSize: 'var(--text-2xs)',
        color: hover ? 'var(--text-secondary)' : 'var(--text-muted)',
        boxShadow: 'var(--shadow-input)',
        transition: 'color var(--duration-base)',
        ...style,
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flex: 'none' }}
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {placeholder}
      </span>
      <ShortcutKey shortcut={shortcut} ghost />
    </div>
  )
}
