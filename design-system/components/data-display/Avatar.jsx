import React from 'react'

/**
 * Avatar — circular identity chip. Pass `src` for a photo (testimonials) or
 * let it render initials on a deterministic indigo-tinted background. The
 * `graphColor` variant renders Reflect's small round graph-color dot.
 */
export function Avatar({ src, name = '', size = 32, graphColor, style = {} }) {
  if (graphColor) {
    return (
      <span
        style={{
          width: size * 0.4,
          height: size * 0.4,
          borderRadius: 'var(--radius-full)',
          background: graphColor,
          boxShadow: '0 0 0 2px color-mix(in srgb, ' + graphColor + ' 25%, transparent)',
          display: 'inline-block',
          ...style,
        }}
      />
    )
  }
  const initials = name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 'var(--radius-full)',
        overflow: 'hidden',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--accent-soft)',
        color: 'var(--accent)',
        fontFamily: 'var(--font-sans)',
        fontSize: size * 0.38,
        fontWeight: 'var(--weight-semibold)',
        ...style,
      }}
    >
      {src ? (
        <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        initials
      )}
    </span>
  )
}
