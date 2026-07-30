import React from 'react'

/**
 * Reflect Button — the real variants from the product.
 * Primary = solid indigo-600 (every confirming action). Secondary = soft
 * indigo. White = bordered neutral. Text/ghost = chromeless. Space = the
 * glassmorphic marketing button for the dark "deep space" surface.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  disabled = false,
  type = 'button',
  leadingIcon,
  trailingIcon,
  onClick,
  className = '',
  style = {},
  children,
}) {
  const pad =
    size === 'sm'
      ? { padding: '6px 12px', fontSize: 'var(--text-2xs)' }
      : { padding: '8px 14px', fontSize: 'var(--text-sm)' }

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: 'var(--font-sans)',
    fontWeight: 'var(--weight-medium)',
    lineHeight: 1,
    borderRadius: 'var(--radius-lg)',
    border: '1px solid transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition:
      'background var(--duration-base) var(--ease-in-out), color var(--duration-fast), box-shadow var(--duration-base), opacity var(--duration-fast)',
    whiteSpace: 'nowrap',
    ...pad,
  }

  const variants = {
    primary: {
      background: disabled ? 'var(--coolgray-400)' : 'var(--accent)',
      color: 'var(--text-on-brand)',
      boxShadow: 'var(--shadow-sm)',
    },
    secondary: {
      background: 'var(--accent-soft)',
      color: 'var(--accent-soft-text)',
    },
    white: {
      background: 'var(--surface)',
      color: 'var(--coolgray-700)',
      boxShadow: 'var(--shadow-sm)',
      border: '1px solid var(--border)',
    },
    text: {
      background: 'transparent',
      color: 'var(--text-secondary)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text)',
    },
    space: {
      background:
        'linear-gradient(180deg,rgba(60,8,126,0) 0%,rgba(60,8,126,.32) 100%),rgba(113,47,255,.12)',
      color: 'var(--purple-text)',
      boxShadow: 'inset 0 0 12px rgba(191,151,255,.24), inset 0 0 0 1px rgba(207,184,255,.24)',
      backdropFilter: 'blur(8px)',
    },
  }

  const [hover, setHover] = React.useState(false)
  const hoverStyle =
    hover && !disabled
      ? {
          primary: { background: 'var(--accent-hover)' },
          secondary: { background: 'var(--indigo-50)' },
          white: { color: 'var(--purple-light)' },
          text: { color: 'var(--text)' },
          ghost: { background: 'var(--surface-hover)' },
          space: {
            background:
              'linear-gradient(180deg,rgba(60,8,126,0) 0%,rgba(60,8,126,.42) 100%),rgba(113,47,255,.24)',
            boxShadow:
              'inset 0 0 12px rgba(191,151,255,.44), inset 0 0 0 1px rgba(207,184,255,.32)',
          },
        }[variant]
      : null

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={className}
      style={{
        ...base,
        ...variants[variant],
        ...hoverStyle,
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  )
}
