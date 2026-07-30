import React from 'react'

/**
 * Badge — a small pill for tags, counts and status. `tag` is the editor's
 * #hashtag style; `accent` / `success` / `warning` carry status; `neutral`
 * is the default soft-grey chip.
 */
export function Badge({ variant = 'neutral', children, style = {} }) {
  const variants = {
    neutral: { background: 'var(--coolgray-100)', color: 'var(--coolgray-600)' },
    accent: { background: 'var(--accent-soft)', color: 'var(--accent-soft-text)' },
    success: {
      background: 'color-mix(in srgb, var(--green-500) 16%, transparent)',
      color: '#15803d',
    },
    warning: {
      background: 'color-mix(in srgb, var(--amber-500) 18%, transparent)',
      color: '#b45309',
    },
    tag: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-2xs)',
        fontWeight: 'var(--weight-medium)',
        lineHeight: 1.5,
        borderRadius: 'var(--radius-full)',
        whiteSpace: 'nowrap',
        ...variants[variant],
        ...style,
      }}
    >
      {variant === 'tag' && <span style={{ opacity: 0.7 }}>#</span>}
      {children}
    </span>
  )
}
