import React from 'react'

/**
 * Input — Reflect's text field. Quiet white surface, a hairline outline that
 * warms to indigo on focus, the house 7px radius, and a soft inset shadow.
 */
export function Input({
  value,
  defaultValue,
  placeholder,
  type = 'text',
  disabled = false,
  leadingIcon,
  onChange,
  className = '',
  style = {},
}) {
  const [focus, setFocus] = React.useState(false)
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--input-bg)',
        border: `1px solid ${focus ? 'var(--focus-ring)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '8px 10px',
        boxShadow: focus
          ? '0 0 0 3px color-mix(in srgb, var(--focus-ring) 25%, transparent)'
          : 'var(--shadow-input)',
        transition: 'border-color var(--duration-base), box-shadow var(--duration-base)',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      {leadingIcon && (
        <span style={{ display: 'flex', color: 'var(--text-muted)', flex: 'none' }}>
          {leadingIcon}
        </span>
      )}
      <input
        type={type}
        value={value}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        onChange={onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text)',
          padding: 0,
        }}
      />
    </div>
  )
}
