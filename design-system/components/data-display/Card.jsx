import React from 'react'

/**
 * Card — a quiet surface container. Reflect cards are flat: a hairline border
 * and the house 8px radius do the work; pass `elevated` for a floating panel
 * (popovers, dialogs) which adds a soft shadow and a larger radius.
 */
export function Card({
  elevated = false,
  padding = 16,
  onClick,
  className = '',
  style = {},
  children,
}) {
  return (
    <div
      onClick={onClick}
      className={className}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: elevated ? 'var(--radius-xl)' : 'var(--radius-lg)',
        boxShadow: elevated ? 'var(--shadow-pop)' : 'none',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  )
}
