import React from 'react'

/**
 * MenuItem — Reflect's sidebar / dropdown row. Leading icon + label, with the
 * translucent grey hover wash and selected state from the real app. An
 * optional shortcut keycap appears on the right on hover.
 */
export function MenuItem({
  icon,
  selected = false,
  shortcut,
  onClick,
  className = '',
  style = {},
  children,
}) {
  const [hover, setHover] = React.useState(false)
  return (
    <a
      onMouseDown={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 10px',
        borderRadius: 'var(--radius-lg)',
        cursor: 'default',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        fontWeight: 'var(--weight-medium)',
        color: selected ? 'var(--text)' : 'var(--text-secondary)',
        background: selected || hover ? 'var(--surface-hover)' : 'transparent',
        transition: 'background var(--duration-fast), color var(--duration-fast)',
        ...style,
      }}
    >
      {icon && <span style={{ display: 'flex', flex: 'none', color: 'currentColor' }}>{icon}</span>}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
      {shortcut && (
        <span style={{ visibility: hover ? 'visible' : 'hidden', flex: 'none' }}>{shortcut}</span>
      )}
    </a>
  )
}
