import React from 'react'

/**
 * Checkbox — the task / to-do checkbox from the editor. Square with the house
 * 4px radius; checked fills indigo with a white tick.
 */
export function Checkbox({ checked = false, disabled = false, label, onChange, style = {} }) {
  const box = {
    width: 16,
    height: 16,
    flex: 'none',
    borderRadius: 'var(--radius-sm)',
    border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--coolgray-400)'}`,
    background: checked ? 'var(--accent)' : 'transparent',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'background var(--duration-fast), border-color var(--duration-fast)',
  }
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)',
        color: 'var(--text)',
        ...style,
      }}
    >
      <span style={box} onClick={() => !disabled && onChange && onChange(!checked)}>
        {checked && (
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      {label && (
        <span
          style={{
            textDecoration: checked ? 'line-through' : 'none',
            color: checked ? 'var(--text-muted)' : 'var(--text)',
          }}
        >
          {label}
        </span>
      )}
    </label>
  )
}
