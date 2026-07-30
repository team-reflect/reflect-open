/* @ds-bundle: {"format":3,"namespace":"ReflectDesignSystem_06b075","components":[{"name":"Button","sourcePath":"components/buttons/Button.jsx"},{"name":"IconButton","sourcePath":"components/buttons/IconButton.jsx"},{"name":"ShortcutKey","sourcePath":"components/buttons/ShortcutKey.jsx"},{"name":"Avatar","sourcePath":"components/data-display/Avatar.jsx"},{"name":"Badge","sourcePath":"components/data-display/Badge.jsx"},{"name":"Card","sourcePath":"components/data-display/Card.jsx"},{"name":"MenuItem","sourcePath":"components/data-display/MenuItem.jsx"},{"name":"Checkbox","sourcePath":"components/forms/Checkbox.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"SearchField","sourcePath":"components/forms/SearchField.jsx"},{"name":"Toggle","sourcePath":"components/forms/Toggle.jsx"}],"sourceHashes":{"components/buttons/Button.jsx":"9e660d45285a","components/buttons/IconButton.jsx":"8dee9707546d","components/buttons/ShortcutKey.jsx":"b4b92561fae0","components/data-display/Avatar.jsx":"5b18b6ff8aa1","components/data-display/Badge.jsx":"ae619128d7d3","components/data-display/Card.jsx":"cb7cd8addb1b","components/data-display/MenuItem.jsx":"5f925d0ab023","components/forms/Checkbox.jsx":"6aef62a9add5","components/forms/Input.jsx":"3c8735f04734","components/forms/SearchField.jsx":"05d230f7dadc","components/forms/Toggle.jsx":"9052133256cd","ui_kits/app/AppShell.jsx":"0a84823d47ce","ui_kits/app/SearchModal.jsx":"279eb1c671cb","ui_kits/app/Sidebar.jsx":"d60be9f8aa9c","ui_kits/app/Views.jsx":"64fd3337df71","ui_kits/app/icons.jsx":"efb478059ebf","ui_kits/marketing/Site.jsx":"7c6fec8fa38f"},"inlinedExternals":[],"unexposedExports":[]} */

;(() => {
  const __ds_ns = (window.ReflectDesignSystem_06b075 = window.ReflectDesignSystem_06b075 || {})

  const __ds_scope = {}

  __ds_ns.__errors = __ds_ns.__errors || []

  // components/buttons/Button.jsx
  try {
    ;(() => {
      /**
       * Reflect Button — the real variants from the product.
       * Primary = solid indigo-600 (every confirming action). Secondary = soft
       * indigo. White = bordered neutral. Text/ghost = chromeless. Space = the
       * glassmorphic marketing button for the dark "deep space" surface.
       */
      function Button({
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
            ? {
                padding: '6px 12px',
                fontSize: 'var(--text-2xs)',
              }
            : {
                padding: '8px 14px',
                fontSize: 'var(--text-sm)',
              }
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
            boxShadow:
              'inset 0 0 12px rgba(191,151,255,.24), inset 0 0 0 1px rgba(207,184,255,.24)',
            backdropFilter: 'blur(8px)',
          },
        }
        const [hover, setHover] = React.useState(false)
        const hoverStyle =
          hover && !disabled
            ? {
                primary: {
                  background: 'var(--accent-hover)',
                },
                secondary: {
                  background: 'var(--indigo-50)',
                },
                white: {
                  color: 'var(--purple-light)',
                },
                text: {
                  color: 'var(--text)',
                },
                ghost: {
                  background: 'var(--surface-hover)',
                },
                space: {
                  background:
                    'linear-gradient(180deg,rgba(60,8,126,0) 0%,rgba(60,8,126,.42) 100%),rgba(113,47,255,.24)',
                  boxShadow:
                    'inset 0 0 12px rgba(191,151,255,.44), inset 0 0 0 1px rgba(207,184,255,.32)',
                },
              }[variant]
            : null
        return /*#__PURE__*/ React.createElement(
          'button',
          {
            type: type,
            disabled: disabled,
            onClick: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            className: className,
            style: {
              ...base,
              ...variants[variant],
              ...hoverStyle,
              opacity: disabled ? 0.6 : 1,
              ...style,
            },
          },
          leadingIcon,
          children,
          trailingIcon,
        )
      }
      Object.assign(__ds_scope, { Button })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/buttons/Button.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/buttons/IconButton.jsx
  try {
    ;(() => {
      /**
       * IconButton — a square, chromeless icon target (sidebar nav arrows,
       * toolbar actions, audio record). Hover paints the translucent grey wash
       * Reflect uses across menus and list rows.
       */
      function IconButton({
        size = 28,
        active = false,
        disabled = false,
        label,
        onClick,
        className = '',
        style = {},
        children,
      }) {
        const [hover, setHover] = React.useState(false)
        return /*#__PURE__*/ React.createElement(
          'button',
          {
            type: 'button',
            'aria-label': label,
            title: label,
            disabled: disabled,
            onClick: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            className: className,
            style: {
              width: size,
              height: size,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              color: active ? 'var(--text)' : 'var(--text-secondary)',
              background: active || hover ? 'var(--surface-hover)' : 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: 'background var(--duration-fast), color var(--duration-fast)',
              ...style,
            },
          },
          children,
        )
      }
      Object.assign(__ds_scope, { IconButton })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/buttons/IconButton.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/buttons/ShortcutKey.jsx
  try {
    ;(() => {
      /**
       * ShortcutKey — Reflect renders keyboard shortcuts as small, low-contrast
       * keycaps (⌘K, mod+shift+d). Pass a shortcut string; `mod` becomes ⌘ on
       * Apple, Ctrl elsewhere. `ghost` is the faint inline style used inside the
       * search field.
       */
      function ShortcutKey({ shortcut = '', apple = true, ghost = false, style = {} }) {
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
        return /*#__PURE__*/ React.createElement(
          'span',
          {
            style: {
              display: 'inline-flex',
              gap: 3,
              ...style,
            },
          },
          keys.map((k, i) =>
            /*#__PURE__*/ React.createElement(
              'kbd',
              {
                key: i,
                style: cap,
              },
              k,
            ),
          ),
        )
      }
      Object.assign(__ds_scope, { ShortcutKey })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/buttons/ShortcutKey.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/data-display/Avatar.jsx
  try {
    ;(() => {
      /**
       * Avatar — circular identity chip. Pass `src` for a photo (testimonials) or
       * let it render initials on a deterministic indigo-tinted background. The
       * `graphColor` variant renders Reflect's small round graph-color dot.
       */
      function Avatar({ src, name = '', size = 32, graphColor, style = {} }) {
        if (graphColor) {
          return /*#__PURE__*/ React.createElement('span', {
            style: {
              width: size * 0.4,
              height: size * 0.4,
              borderRadius: 'var(--radius-full)',
              background: graphColor,
              boxShadow: '0 0 0 2px color-mix(in srgb, ' + graphColor + ' 25%, transparent)',
              display: 'inline-block',
              ...style,
            },
          })
        }
        const initials = name
          .split(' ')
          .map((w) => w[0])
          .slice(0, 2)
          .join('')
          .toUpperCase()
        return /*#__PURE__*/ React.createElement(
          'span',
          {
            style: {
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
            },
          },
          src
            ? /*#__PURE__*/ React.createElement('img', {
                src: src,
                alt: name,
                style: {
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                },
              })
            : initials,
        )
      }
      Object.assign(__ds_scope, { Avatar })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/data-display/Avatar.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/data-display/Badge.jsx
  try {
    ;(() => {
      /**
       * Badge — a small pill for tags, counts and status. `tag` is the editor's
       * #hashtag style; `accent` / `success` / `warning` carry status; `neutral`
       * is the default soft-grey chip.
       */
      function Badge({ variant = 'neutral', children, style = {} }) {
        const variants = {
          neutral: {
            background: 'var(--coolgray-100)',
            color: 'var(--coolgray-600)',
          },
          accent: {
            background: 'var(--accent-soft)',
            color: 'var(--accent-soft-text)',
          },
          success: {
            background: 'color-mix(in srgb, var(--green-500) 16%, transparent)',
            color: '#15803d',
          },
          warning: {
            background: 'color-mix(in srgb, var(--amber-500) 18%, transparent)',
            color: '#b45309',
          },
          tag: {
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
          },
        }
        return /*#__PURE__*/ React.createElement(
          'span',
          {
            style: {
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
            },
          },
          variant === 'tag' &&
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  opacity: 0.7,
                },
              },
              '#',
            ),
          children,
        )
      }
      Object.assign(__ds_scope, { Badge })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/data-display/Badge.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/data-display/Card.jsx
  try {
    ;(() => {
      /**
       * Card — a quiet surface container. Reflect cards are flat: a hairline border
       * and the house 8px radius do the work; pass `elevated` for a floating panel
       * (popovers, dialogs) which adds a soft shadow and a larger radius.
       */
      function Card({
        elevated = false,
        padding = 16,
        onClick,
        className = '',
        style = {},
        children,
      }) {
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            onClick: onClick,
            className: className,
            style: {
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: elevated ? 'var(--radius-xl)' : 'var(--radius-lg)',
              boxShadow: elevated ? 'var(--shadow-pop)' : 'none',
              padding,
              ...style,
            },
          },
          children,
        )
      }
      Object.assign(__ds_scope, { Card })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/data-display/Card.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/data-display/MenuItem.jsx
  try {
    ;(() => {
      /**
       * MenuItem — Reflect's sidebar / dropdown row. Leading icon + label, with the
       * translucent grey hover wash and selected state from the real app. An
       * optional shortcut keycap appears on the right on hover.
       */
      function MenuItem({
        icon,
        selected = false,
        shortcut,
        onClick,
        className = '',
        style = {},
        children,
      }) {
        const [hover, setHover] = React.useState(false)
        return /*#__PURE__*/ React.createElement(
          'a',
          {
            onMouseDown: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            className: className,
            style: {
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
            },
          },
          icon &&
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  display: 'flex',
                  flex: 'none',
                  color: 'currentColor',
                },
              },
              icon,
            ),
          /*#__PURE__*/ React.createElement(
            'span',
            {
              style: {
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            children,
          ),
          shortcut &&
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  visibility: hover ? 'visible' : 'hidden',
                  flex: 'none',
                },
              },
              shortcut,
            ),
        )
      }
      Object.assign(__ds_scope, { MenuItem })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/data-display/MenuItem.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/forms/Checkbox.jsx
  try {
    ;(() => {
      /**
       * Checkbox — the task / to-do checkbox from the editor. Square with the house
       * 4px radius; checked fills indigo with a white tick.
       */
      function Checkbox({ checked = false, disabled = false, label, onChange, style = {} }) {
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
        return /*#__PURE__*/ React.createElement(
          'label',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text)',
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement(
            'span',
            {
              style: box,
              onClick: () => !disabled && onChange && onChange(!checked),
            },
            checked &&
              /*#__PURE__*/ React.createElement(
                'svg',
                {
                  width: '11',
                  height: '11',
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: '#fff',
                  strokeWidth: '3.5',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                },
                /*#__PURE__*/ React.createElement('polyline', {
                  points: '20 6 9 17 4 12',
                }),
              ),
          ),
          label &&
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  textDecoration: checked ? 'line-through' : 'none',
                  color: checked ? 'var(--text-muted)' : 'var(--text)',
                },
              },
              label,
            ),
        )
      }
      Object.assign(__ds_scope, { Checkbox })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/forms/Checkbox.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/forms/Input.jsx
  try {
    ;(() => {
      /**
       * Input — Reflect's text field. Quiet white surface, a hairline outline that
       * warms to indigo on focus, the house 7px radius, and a soft inset shadow.
       */
      function Input({
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
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            className: className,
            style: {
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
            },
          },
          leadingIcon &&
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  display: 'flex',
                  color: 'var(--text-muted)',
                  flex: 'none',
                },
              },
              leadingIcon,
            ),
          /*#__PURE__*/ React.createElement('input', {
            type: type,
            value: value,
            defaultValue: defaultValue,
            placeholder: placeholder,
            disabled: disabled,
            onChange: onChange,
            onFocus: () => setFocus(true),
            onBlur: () => setFocus(false),
            style: {
              flex: 1,
              minWidth: 0,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-sm)',
              color: 'var(--text)',
              padding: 0,
            },
          }),
        )
      }
      Object.assign(__ds_scope, { Input })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/forms/Input.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/forms/SearchField.jsx
  try {
    ;(() => {
      /**
       * SearchField — Reflect's signature "Search anything…" trigger that lives at
       * the top of the sidebar. It's a button styled as an input: magnifier, muted
       * placeholder, and a ghost ⌘K keycap pinned to the right.
       */
      function SearchField({
        placeholder = 'Search anything…',
        shortcut = 'mod+k',
        onClick,
        className = '',
        style = {},
      }) {
        const [hover, setHover] = React.useState(false)
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            role: 'button',
            onClick: onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
            className: className,
            style: {
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
            },
          },
          /*#__PURE__*/ React.createElement(
            'svg',
            {
              width: '14',
              height: '14',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: '1.75',
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              style: {
                flex: 'none',
              },
            },
            /*#__PURE__*/ React.createElement('circle', {
              cx: '11',
              cy: '11',
              r: '7',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '21',
              y1: '21',
              x2: '16.65',
              y2: '16.65',
            }),
          ),
          /*#__PURE__*/ React.createElement(
            'span',
            {
              style: {
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            placeholder,
          ),
          /*#__PURE__*/ React.createElement(__ds_scope.ShortcutKey, {
            shortcut: shortcut,
            ghost: true,
          }),
        )
      }
      Object.assign(__ds_scope, { SearchField })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/forms/SearchField.jsx',
      error: String((e && e.message) || e),
    })
  }

  // components/forms/Toggle.jsx
  try {
    ;(() => {
      /**
       * Toggle — a small switch used in Preferences (e.g. spell-check, dark mode).
       * Indigo when on; slides with a calm 150ms transition (no bounce).
       */
      function Toggle({ checked = false, disabled = false, onChange, style = {} }) {
        return /*#__PURE__*/ React.createElement(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked,
            disabled: disabled,
            onClick: () => !disabled && onChange && onChange(!checked),
            style: {
              width: 36,
              height: 20,
              flex: 'none',
              padding: 2,
              borderRadius: 'var(--radius-full)',
              border: 'none',
              background: checked ? 'var(--accent)' : 'var(--coolgray-300)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
              transition: 'background var(--duration-base) var(--ease-in-out)',
              display: 'inline-flex',
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement('span', {
            style: {
              width: 16,
              height: 16,
              borderRadius: 'var(--radius-full)',
              background: '#fff',
              boxShadow: 'var(--shadow-sm)',
              transform: checked ? 'translateX(16px)' : 'translateX(0)',
              transition: 'transform var(--duration-base) var(--ease-in-out)',
            },
          }),
        )
      }
      Object.assign(__ds_scope, { Toggle })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'components/forms/Toggle.jsx',
      error: String((e && e.message) || e),
    })
  }

  // ui_kits/app/AppShell.jsx
  try {
    ;(() => {
      /* Reflect app — shell. Wires sidebar navigation, the ⌘K modal, and the
   active content view together. */
      function AppShell() {
        const { Sidebar, DailyNotes, AllNotes, Tasks, MapView, SearchModal } = window.AppKit
        const [screen, setScreen] = React.useState('daily')
        const [search, setSearch] = React.useState(false)
        const [selectedNote, setSelectedNote] = React.useState(null)
        React.useEffect(() => {
          const onKey = (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
              e.preventDefault()
              setSearch(true)
            }
          }
          window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [])
        const openNote = (name) => {
          setSelectedNote(name)
          setScreen('all')
        }
        const titles = {
          daily: 'Daily notes',
          all: 'All notes',
          tasks: 'Tasks',
          map: 'Map',
        }
        const View = {
          daily: DailyNotes,
          all: AllNotes,
          tasks: Tasks,
          map: MapView,
        }[screen]
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            style: {
              position: 'absolute',
              inset: 0,
              display: 'flex',
              background: 'var(--surface)',
              overflow: 'hidden',
            },
          },
          /*#__PURE__*/ React.createElement(Sidebar, {
            screen: screen,
            onNavigate: (s) => {
              setScreen(s)
              setSelectedNote(null)
            },
            onOpenSearch: () => setSearch(true),
            pinned: ['Morning routine', 'Reading', 'Weekly review'],
            selectedNote: selectedNote,
            onOpenNote: openNote,
          }),
          /*#__PURE__*/ React.createElement(
            'main',
            {
              style: {
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                position: 'relative',
              },
            },
            /*#__PURE__*/ React.createElement(View, {
              onOpenNote: openNote,
              key: screen,
            }),
          ),
          /*#__PURE__*/ React.createElement(SearchModal, {
            open: search,
            onClose: () => setSearch(false),
            onOpenNote: openNote,
          }),
        )
      }
      window.AppKit = Object.assign(window.AppKit || {}, {
        AppShell,
      })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'ui_kits/app/AppShell.jsx',
      error: String((e && e.message) || e),
    })
  }

  // ui_kits/app/SearchModal.jsx
  try {
    ;(() => {
      /* Reflect app — ⌘K command / search modal. Elevated card over a dim scrim. */
      const NS_S = 'ReflectDesignSystem_06b075'
      function SearchModal({ open, onClose, onOpenNote }) {
        const { Card, ShortcutKey } = window[NS_S]
        const I = window.RIcons
        const [q, setQ] = React.useState('')
        React.useEffect(() => {
          const onKey = (e) => {
            if (e.key === 'Escape') onClose()
          }
          if (open) window.addEventListener('keydown', onKey)
          return () => window.removeEventListener('keydown', onKey)
        }, [open])
        if (!open) return null
        const results = [
          {
            icon: /*#__PURE__*/ React.createElement(I.Pencil, {
              size: 15,
            }),
            label: 'Jump to today',
            meta: 'Daily notes',
          },
          {
            icon: /*#__PURE__*/ React.createElement(I.Sparkles, {
              size: 15,
            }),
            label: 'Ask Reflect AI…',
            meta: 'AI',
          },
          {
            icon: /*#__PURE__*/ React.createElement(I.List, {
              size: 15,
            }),
            label: 'Morning routine',
            meta: 'Note',
          },
          {
            icon: /*#__PURE__*/ React.createElement(I.List, {
              size: 15,
            }),
            label: 'Design sync',
            meta: 'Note',
          },
          {
            icon: /*#__PURE__*/ React.createElement(I.Calendar, {
              size: 15,
            }),
            label: 'The Beginning of Infinity',
            meta: 'Note',
          },
        ].filter((r) => r.label.toLowerCase().includes(q.toLowerCase()))
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            onMouseDown: onClose,
            style: {
              position: 'absolute',
              inset: 0,
              zIndex: 50,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'flex-start',
              paddingTop: '14vh',
              background: 'rgba(11,19,36,.28)',
              backdropFilter: 'blur(2px)',
            },
          },
          /*#__PURE__*/ React.createElement(
            Card,
            {
              elevated: true,
              padding: 0,
              onClick: (e) => e.stopPropagation?.(),
              style: {
                width: 560,
                maxWidth: '88%',
                overflow: 'hidden',
              },
            },
            /*#__PURE__*/ React.createElement(
              'div',
              {
                onMouseDown: (e) => e.stopPropagation(),
              },
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '14px 16px',
                    borderBottom: '1px solid var(--border)',
                  },
                },
                /*#__PURE__*/ React.createElement(I.Search, {
                  size: 18,
                  style: {
                    color: 'var(--text-muted)',
                  },
                }),
                /*#__PURE__*/ React.createElement('input', {
                  autoFocus: true,
                  value: q,
                  onChange: (e) => setQ(e.target.value),
                  placeholder: 'Search anything\u2026',
                  style: {
                    flex: 1,
                    border: 'none',
                    outline: 'none',
                    background: 'transparent',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--text-lg)',
                    color: 'var(--text)',
                  },
                }),
                /*#__PURE__*/ React.createElement(
                  'span',
                  {
                    style: {
                      fontSize: 11,
                      color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      padding: '2px 6px',
                    },
                  },
                  'esc',
                ),
              ),
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  style: {
                    padding: 8,
                    maxHeight: 320,
                    overflowY: 'auto',
                  },
                },
                results.length === 0 &&
                  /*#__PURE__*/ React.createElement(
                    'div',
                    {
                      style: {
                        padding: '18px 12px',
                        color: 'var(--text-muted)',
                        fontSize: 14,
                      },
                    },
                    'No results for \u201C',
                    q,
                    '\u201D.',
                  ),
                results.map((r, i) =>
                  /*#__PURE__*/ React.createElement(
                    'div',
                    {
                      key: i,
                      onMouseDown: () => {
                        onOpenNote(r.label)
                        onClose()
                      },
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '9px 12px',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'default',
                      },
                      onMouseEnter: (e) =>
                        (e.currentTarget.style.background = 'var(--surface-hover)'),
                      onMouseLeave: (e) => (e.currentTarget.style.background = 'transparent'),
                    },
                    /*#__PURE__*/ React.createElement(
                      'span',
                      {
                        style: {
                          color: 'var(--text-secondary)',
                          display: 'flex',
                        },
                      },
                      r.icon,
                    ),
                    /*#__PURE__*/ React.createElement(
                      'span',
                      {
                        style: {
                          flex: 1,
                          fontSize: 'var(--text-sm)',
                          color: 'var(--text)',
                        },
                      },
                      r.label,
                    ),
                    /*#__PURE__*/ React.createElement(
                      'span',
                      {
                        style: {
                          fontSize: 'var(--text-2xs)',
                          color: 'var(--text-muted)',
                        },
                      },
                      r.meta,
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      }
      window.AppKit = Object.assign(window.AppKit || {}, {
        SearchModal,
      })
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'ui_kits/app/SearchModal.jsx',
      error: String((e && e.message) || e),
    })
  }

  // ui_kits/app/Sidebar.jsx
  try {
    ;(() => {
      /* Reflect app — left sidebar. Composes SearchField, IconButton, MenuItem,
   ShortcutKey, Avatar from the design system bundle. */
      const NS = 'ReflectDesignSystem_06b075'
      function Sidebar({ screen, onNavigate, onOpenSearch, pinned, selectedNote, onOpenNote }) {
        const { SearchField, IconButton, MenuItem, ShortcutKey, Avatar } = window[NS]
        const I = window.RIcons
        const nav = [
          {
            key: 'daily',
            label: 'Daily notes',
            icon: /*#__PURE__*/ React.createElement(I.Pencil, null),
            sc: 'mod+shift+d',
          },
          {
            key: 'all',
            label: 'All notes',
            icon: /*#__PURE__*/ React.createElement(I.List, null),
            sc: 'mod+shift+a',
          },
          {
            key: 'tasks',
            label: 'Tasks',
            icon: /*#__PURE__*/ React.createElement(I.Check, null),
            sc: 'mod+shift+t',
          },
          {
            key: 'map',
            label: 'Map',
            icon: /*#__PURE__*/ React.createElement(I.Map, null),
            sc: 'mod+shift+m',
          },
        ]
        return /*#__PURE__*/ React.createElement(
          'aside',
          {
            style: {
              width: 260,
              flex: 'none',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface-sunken)',
              borderRight: '1px solid var(--border)',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                gap: 8,
                padding: '14px 16px 0',
              },
            },
            /*#__PURE__*/ React.createElement('span', {
              style: {
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#ff5f57',
              },
            }),
            /*#__PURE__*/ React.createElement('span', {
              style: {
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#febc2e',
              },
            }),
            /*#__PURE__*/ React.createElement('span', {
              style: {
                width: 12,
                height: 12,
                borderRadius: '50%',
                background: '#28c840',
              },
            }),
          ),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 20,
                padding: '18px 0',
              },
            },
            /*#__PURE__*/ React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  gap: 8,
                  padding: '0 16px',
                },
              },
              /*#__PURE__*/ React.createElement(SearchField, {
                onClick: onOpenSearch,
              }),
              /*#__PURE__*/ React.createElement(
                IconButton,
                {
                  label: 'Record audio',
                },
                /*#__PURE__*/ React.createElement(I.Mic, {
                  size: 16,
                }),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              'nav',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  padding: '0 12px',
                },
              },
              nav.map((n) =>
                /*#__PURE__*/ React.createElement(
                  MenuItem,
                  {
                    key: n.key,
                    icon: n.icon,
                    selected: screen === n.key,
                    shortcut: /*#__PURE__*/ React.createElement(ShortcutKey, {
                      shortcut: n.sc,
                    }),
                    onClick: () => onNavigate(n.key),
                  },
                  n.label,
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              'div',
              {
                style: {
                  padding: '0 16px',
                },
              },
              /*#__PURE__*/ React.createElement(
                'h3',
                {
                  style: {
                    margin: '0 0 8px',
                    fontSize: 'var(--text-xs)',
                    fontWeight: 500,
                    letterSpacing: 'var(--tracking-wide)',
                    color: 'var(--text-muted)',
                  },
                },
                'Pinned notes',
              ),
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  },
                },
                pinned.map((p) => {
                  const sel = selectedNote === p
                  return /*#__PURE__*/ React.createElement(
                    'div',
                    {
                      key: p,
                      onMouseDown: () => onOpenNote(p),
                      style: {
                        padding: '4px 8px',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'default',
                        fontSize: 'var(--text-2xs)',
                        fontWeight: 500,
                        color: sel ? 'var(--text)' : 'var(--text-secondary)',
                        background: sel ? 'var(--surface-hover)' : 'transparent',
                      },
                      onMouseEnter: (e) => {
                        if (!sel) e.currentTarget.style.background = 'var(--surface-hover)'
                      },
                      onMouseLeave: (e) => {
                        if (!sel) e.currentTarget.style.background = 'transparent'
                      },
                    },
                    p,
                  )
                }),
              ),
            ),
          ),
          /*#__PURE__*/ React.createElement('div', {
            style: {
              flex: 1,
            },
          }),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '14px 16px',
                borderTop: '1px solid var(--border)',
                cursor: 'default',
              },
            },
            /*#__PURE__*/ React.createElement(Avatar, {
              graphColor: '#4F46E5',
              size: 30,
            }),
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  color: 'var(--text)',
                },
              },
              'My Graph',
            ),
            /*#__PURE__*/ React.createElement('span', {
              style: {
                flex: 1,
              },
            }),
            /*#__PURE__*/ React.createElement(window.RIcons.ChevronDown, {
              size: 14,
              style: {
                color: 'var(--text-muted)',
              },
            }),
          ),
        )
      }
      window.AppKit = Object.assign(window.AppKit || {}, {
        Sidebar,
      })
    })()
  } catch (e) {
    __ds_ns.__errors.push({ path: 'ui_kits/app/Sidebar.jsx', error: String((e && e.message) || e) })
  }

  // ui_kits/app/Views.jsx
  try {
    ;(() => {
      /* Reflect app — main content views. The daily-notes editor is the home
   surface: date-titled blocks of bulleted prose with backlinks & tags. */
      const NS_V = 'ReflectDesignSystem_06b075'

      /* --- inline editor primitives ------------------------------------ */
      const Backlink = ({ children, onClick }) =>
        /*#__PURE__*/ React.createElement(
          'span',
          {
            onMouseDown: onClick,
            style: {
              color: 'var(--accent)',
              cursor: 'pointer',
              fontWeight: 500,
              boxShadow: 'inset 0 -1px 0 color-mix(in srgb, var(--accent) 35%, transparent)',
            },
          },
          children,
        )
      const Tag = ({ children }) =>
        /*#__PURE__*/ React.createElement(
          'span',
          {
            style: {
              color: 'var(--accent)',
              background: 'var(--accent-soft)',
              borderRadius: 'var(--radius-sm)',
              padding: '0 5px',
              fontWeight: 500,
              fontSize: '0.92em',
            },
          },
          '#',
          children,
        )
      const Bullet = ({ children, style }) =>
        /*#__PURE__*/ React.createElement(
          'li',
          {
            style: {
              position: 'relative',
              paddingLeft: 22,
              marginBottom: 7,
              fontSize: 'var(--text-base)',
              lineHeight: 'var(--leading-relaxed)',
              color: 'var(--text)',
              ...style,
            },
          },
          /*#__PURE__*/ React.createElement('span', {
            style: {
              position: 'absolute',
              left: 6,
              top: '0.62em',
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: 'var(--coolgray-400)',
            },
          }),
          children,
        )
      function EditorTask({ text, done0 }) {
        const { Checkbox } = window[NS_V]
        const [done, setDone] = React.useState(done0)
        return /*#__PURE__*/ React.createElement(
          'li',
          {
            style: {
              listStyle: 'none',
              marginBottom: 7,
              marginLeft: -2,
            },
          },
          /*#__PURE__*/ React.createElement(Checkbox, {
            checked: done,
            label: text,
            onChange: setDone,
          }),
        )
      }
      const measure = {
        width: '100%',
        maxWidth: 'var(--editor-measure)',
        margin: '0 auto',
        padding: '0 56px',
      }
      function DayBlock({ date, tense, onOpenNote, children }) {
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              borderBottom: '1px solid var(--border)',
              padding: '32px 0',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: measure,
            },
            /*#__PURE__*/ React.createElement(
              'h1',
              {
                style: {
                  margin: '0 0 16px',
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tracking-tight)',
                  color: tense === 'today' ? 'var(--accent)' : 'var(--text)',
                },
              },
              date,
            ),
            /*#__PURE__*/ React.createElement(
              'ul',
              {
                style: {
                  margin: 0,
                  padding: 0,
                  listStyle: 'none',
                },
              },
              children,
            ),
          ),
        )
      }
      function DailyNotes({ onOpenNote }) {
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            style: {
              flex: 1,
              overflowY: 'auto',
            },
          },
          /*#__PURE__*/ React.createElement(
            DayBlock,
            {
              date: 'Today \xB7 Tuesday, June 8',
              tense: 'today',
              onOpenNote: onOpenNote,
            },
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Morning pages \u2014 felt clear after a walk. Linking back to ',
              /*#__PURE__*/ React.createElement(
                Backlink,
                {
                  onClick: () => onOpenNote('Morning routine'),
                },
                'Morning routine',
              ),
              '.',
            ),
            /*#__PURE__*/ React.createElement(EditorTask, {
              text: 'Finish the Reflect design system',
              done0: false,
            }),
            /*#__PURE__*/ React.createElement(EditorTask, {
              text: 'Review PR on the editor',
              done0: true,
            }),
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Idea: a weekly review template. ',
              /*#__PURE__*/ React.createElement(Tag, null, 'ideas'),
              ' ',
              /*#__PURE__*/ React.createElement(Tag, null, 'productivity'),
            ),
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Meeting notes from ',
              /*#__PURE__*/ React.createElement(
                Backlink,
                {
                  onClick: () => onOpenNote('Design sync'),
                },
                'Design sync',
              ),
              ' \u2014 ship the new onboarding.',
            ),
          ),
          /*#__PURE__*/ React.createElement(
            DayBlock,
            {
              date: 'Monday, June 7',
              tense: 'past',
              onOpenNote: onOpenNote,
            },
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Read two chapters of ',
              /*#__PURE__*/ React.createElement(
                Backlink,
                {
                  onClick: () => onOpenNote('The Beginning of Infinity'),
                },
                'The Beginning of Infinity',
              ),
              '. Good explanations are hard to vary.',
            ),
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Called Mum. ',
              /*#__PURE__*/ React.createElement(Tag, null, 'family'),
            ),
            /*#__PURE__*/ React.createElement(EditorTask, {
              text: 'Book dentist',
              done0: false,
            }),
          ),
          /*#__PURE__*/ React.createElement(
            DayBlock,
            {
              date: 'Sunday, June 6',
              tense: 'past',
              onOpenNote: onOpenNote,
            },
            /*#__PURE__*/ React.createElement(
              Bullet,
              null,
              'Quiet day. Captured a few highlights from Kindle into ',
              /*#__PURE__*/ React.createElement(
                Backlink,
                {
                  onClick: () => onOpenNote('Reading'),
                },
                'Reading',
              ),
              '.',
            ),
          ),
        )
      }
      function AllNotes({ onOpenNote }) {
        const notes = [
          ['Morning routine', 'A short sequence to start the day clear-headed.', '2h ago'],
          ['Design sync', 'Ship the new onboarding; revisit the empty state.', 'Yesterday'],
          ['The Beginning of Infinity', 'Good explanations are hard to vary. Knowledge…', 'Jun 7'],
          ['Reading', 'Kindle highlights and web clips land here.', 'Jun 6'],
          ['Second brain', 'Notes networked through backlinks you can reference anytime.', 'Jun 2'],
          ['Weekly review', 'Template: wins, misses, next.', 'May 30'],
        ]
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            style: {
              flex: 1,
              overflowY: 'auto',
              padding: '32px 0',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: measure,
            },
            /*#__PURE__*/ React.createElement(
              'h1',
              {
                style: {
                  margin: '0 0 4px',
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tracking-tight)',
                },
              },
              'All notes',
            ),
            /*#__PURE__*/ React.createElement(
              'p',
              {
                style: {
                  margin: '0 0 22px',
                  color: 'var(--text-muted)',
                  fontSize: 'var(--text-sm)',
                },
              },
              '142 notes',
            ),
            /*#__PURE__*/ React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                },
              },
              notes.map(([t, d, time]) =>
                /*#__PURE__*/ React.createElement(
                  'div',
                  {
                    key: t,
                    onMouseDown: () => onOpenNote(t),
                    style: {
                      padding: '14px 12px',
                      borderTop: '1px solid var(--border)',
                      cursor: 'default',
                      borderRadius: 8,
                    },
                    onMouseEnter: (e) =>
                      (e.currentTarget.style.background = 'var(--surface-hover)'),
                    onMouseLeave: (e) => (e.currentTarget.style.background = 'transparent'),
                  },
                  /*#__PURE__*/ React.createElement(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 16,
                      },
                    },
                    /*#__PURE__*/ React.createElement(
                      'span',
                      {
                        style: {
                          fontSize: 'var(--text-base)',
                          fontWeight: 500,
                          color: 'var(--text)',
                        },
                      },
                      t,
                    ),
                    /*#__PURE__*/ React.createElement(
                      'span',
                      {
                        style: {
                          fontSize: 'var(--text-2xs)',
                          color: 'var(--text-muted)',
                          flex: 'none',
                        },
                      },
                      time,
                    ),
                  ),
                  /*#__PURE__*/ React.createElement(
                    'div',
                    {
                      style: {
                        fontSize: 'var(--text-sm)',
                        color: 'var(--text-muted)',
                        marginTop: 4,
                      },
                    },
                    d,
                  ),
                ),
              ),
            ),
          ),
        )
      }
      function Tasks() {
        const groups = [
          [
            'Today',
            [
              ['Finish the Reflect design system', false],
              ['Review PR on the editor', true],
            ],
          ],
          [
            'Upcoming',
            [
              ['Book dentist', false],
              ['Plan weekly review', false],
            ],
          ],
        ]
        const { Checkbox } = window[NS_V]
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            style: {
              flex: 1,
              overflowY: 'auto',
              padding: '32px 0',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: measure,
            },
            /*#__PURE__*/ React.createElement(
              'h1',
              {
                style: {
                  margin: '0 0 22px',
                  fontSize: 'var(--text-2xl)',
                  fontWeight: 600,
                  letterSpacing: 'var(--tracking-tight)',
                },
              },
              'Tasks',
            ),
            groups.map(([g, items]) =>
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  key: g,
                  style: {
                    marginBottom: 26,
                  },
                },
                /*#__PURE__*/ React.createElement(
                  'h3',
                  {
                    style: {
                      margin: '0 0 12px',
                      fontSize: 'var(--text-xs)',
                      fontWeight: 500,
                      letterSpacing: 'var(--tracking-wide)',
                      color: 'var(--text-muted)',
                    },
                  },
                  g,
                ),
                /*#__PURE__*/ React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    },
                  },
                  items.map(([t, d], i) =>
                    /*#__PURE__*/ React.createElement(TaskRow, {
                      key: i,
                      text: t,
                      done0: d,
                    }),
                  ),
                ),
              ),
            ),
          ),
        )
      }
      function TaskRow({ text, done0 }) {
        const { Checkbox } = window[NS_V]
        const [done, setDone] = React.useState(done0)
        return /*#__PURE__*/ React.createElement(Checkbox, {
          checked: done,
          label: text,
          onChange: setDone,
          style: {
            fontSize: 'var(--text-base)',
          },
        })
      }
      function MapView() {
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            style: {
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
            },
          },
          /*#__PURE__*/ React.createElement('img', {
            src: '../../assets/reflect-graph-hero.png',
            alt: 'Knowledge graph',
            style: {
              maxWidth: '70%',
              height: 'auto',
              opacity: 0.96,
            },
          }),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                position: 'absolute',
                bottom: 28,
                fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)',
              },
            },
            'Your notes, connected \u2014 142 nodes',
          ),
        )
      }
      window.AppKit = Object.assign(window.AppKit || {}, {
        DailyNotes,
        AllNotes,
        Tasks,
        MapView,
      })
    })()
  } catch (e) {
    __ds_ns.__errors.push({ path: 'ui_kits/app/Views.jsx', error: String((e && e.message) || e) })
  }

  // ui_kits/app/icons.jsx
  try {
    ;(() => {
      function _extends() {
        return (
          (_extends = Object.assign
            ? Object.assign.bind()
            : function (n) {
                for (var e = 1; e < arguments.length; e++) {
                  var t = arguments[e]
                  for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r])
                }
                return n
              }),
          _extends.apply(null, arguments)
        )
      }
      /* Reflect app icons — thin-stroke line set (Lucide-style, 1.75 stroke) to
   match Reflect's hand-built SVG icons. Exported to window for the kit. */
      const RIcon =
        (paths, vb = 24) =>
        ({ size = 16, ...p }) =>
          /*#__PURE__*/ React.createElement(
            'svg',
            _extends(
              {
                width: size,
                height: size,
                viewBox: `0 0 ${vb} ${vb}`,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '1.75',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              },
              p,
            ),
            paths,
          )
      window.RIcons = {
        Pencil: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('path', {
              d: 'M12 20h9',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z',
            }),
          ),
        ),
        List: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('line', {
              x1: '8',
              y1: '6',
              x2: '21',
              y2: '6',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '8',
              y1: '12',
              x2: '21',
              y2: '12',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '8',
              y1: '18',
              x2: '21',
              y2: '18',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '3',
              y1: '6',
              x2: '3.01',
              y2: '6',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '3',
              y1: '12',
              x2: '3.01',
              y2: '12',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '3',
              y1: '18',
              x2: '3.01',
              y2: '18',
            }),
          ),
        ),
        Check: RIcon(
          /*#__PURE__*/ React.createElement('polyline', {
            points: '20 6 9 17 4 12',
          }),
        ),
        CheckCircle: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('path', {
              d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14',
            }),
            /*#__PURE__*/ React.createElement('polyline', {
              points: '22 4 12 14.01 9 11.01',
            }),
          ),
        ),
        Map: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('polygon', {
              points: '1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '8',
              y1: '2',
              x2: '8',
              y2: '18',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '16',
              y1: '6',
              x2: '16',
              y2: '22',
            }),
          ),
        ),
        Mic: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('path', {
              d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M19 10v2a7 7 0 0 1-14 0v-2',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '12',
              y1: '19',
              x2: '12',
              y2: '22',
            }),
          ),
        ),
        Search: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('circle', {
              cx: '11',
              cy: '11',
              r: '7',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '21',
              y1: '21',
              x2: '16.65',
              y2: '16.65',
            }),
          ),
        ),
        ChevronRight: RIcon(
          /*#__PURE__*/ React.createElement('polyline', {
            points: '9 18 15 12 9 6',
          }),
        ),
        ChevronLeft: RIcon(
          /*#__PURE__*/ React.createElement('polyline', {
            points: '15 18 9 12 15 6',
          }),
        ),
        ChevronDown: RIcon(
          /*#__PURE__*/ React.createElement('polyline', {
            points: '6 9 12 15 18 9',
          }),
        ),
        Plus: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('line', {
              x1: '12',
              y1: '5',
              x2: '12',
              y2: '19',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '5',
              y1: '12',
              x2: '19',
              y2: '12',
            }),
          ),
        ),
        Calendar: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('rect', {
              x: '3',
              y: '4',
              width: '18',
              height: '18',
              rx: '2',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '16',
              y1: '2',
              x2: '16',
              y2: '6',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '8',
              y1: '2',
              x2: '8',
              y2: '6',
            }),
            /*#__PURE__*/ React.createElement('line', {
              x1: '3',
              y1: '10',
              x2: '21',
              y2: '10',
            }),
          ),
        ),
        Link: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('path', {
              d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
            }),
          ),
        ),
        Sparkles: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('path', {
              d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M19 15l.7 1.8L21.5 17.5 19.7 18.2 19 20l-.7-1.8L16.5 17.5l1.8-.7L19 15Z',
            }),
          ),
        ),
        Pin: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('line', {
              x1: '12',
              y1: '17',
              x2: '12',
              y2: '22',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M9 2h6l-1 7 3 3v2H7v-2l3-3-1-7Z',
            }),
          ),
        ),
        Settings: RIcon(
          /*#__PURE__*/ React.createElement(
            React.Fragment,
            null,
            /*#__PURE__*/ React.createElement('circle', {
              cx: '12',
              cy: '12',
              r: '3',
            }),
            /*#__PURE__*/ React.createElement('path', {
              d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
            }),
          ),
        ),
      }
    })()
  } catch (e) {
    __ds_ns.__errors.push({ path: 'ui_kits/app/icons.jsx', error: String((e && e.message) || e) })
  }

  // ui_kits/marketing/Site.jsx
  try {
    ;(() => {
      /* Reflect marketing site — the "deep space" homepage. Composes the glass
   `space` Button + Avatar from the design system; everything sits on the
   .reflect-space themed wrapper. */
      const NS_M = 'ReflectDesignSystem_06b075'
      const NAV = ['Product', 'Pricing', 'Company', 'Blog', 'Changelog']
      const FEATURES = [
        ['Built for speed', 'Instantly sync your notes across devices'],
        ['Networked notes', 'Form a graph of ideas with backlinked notes'],
        ['iOS app', 'Capture ideas on the go, online or offline'],
        ['End-to-end encryption', 'Only you can access your notes'],
        ['Calendar integration', 'Keep track of meetings and agendas'],
        ['Publishing', 'Share anything you write with one click'],
        ['Instant capture', 'Save snippets from your browser and Kindle'],
        ['Frictionless search', 'Easily recall and index past notes and ideas'],
      ]
      const LOVE = [
        [
          'Sean Rose',
          '@seanrose',
          "Really, really liking Reflect so far. It's just the right amount of simple/fast for a personal note taking app.",
        ],
        ['Ryan Delk', '@delk', "Don't take it from me: Reflect is magic."],
        [
          'Fabrizio Rinaldi',
          '@linuz90',
          "I'm keeping Reflect open all the time — for journaling and long-form writing. Rare to see one app work so well for both.",
        ],
        [
          'Jonathan Simcoe',
          '@jdsimcoe',
          'The speed, focus, and attention to detail is superb. It has already become a daily driver for me.',
        ],
      ]
      function Header() {
        const { Button } = window[NS_M]
        return /*#__PURE__*/ React.createElement(
          'header',
          {
            style: {
              position: 'sticky',
              top: 0,
              zIndex: 20,
              backdropFilter: 'blur(16px)',
              background: 'rgba(3,0,20,.4)',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                maxWidth: 'var(--site-container)',
                margin: '0 auto',
                padding: '20px 28px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                position: 'relative',
              },
            },
            /*#__PURE__*/ React.createElement(
              'a',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                },
              },
              /*#__PURE__*/ React.createElement('img', {
                src: '../../assets/reflect-app-icon.png',
                width: '34',
                height: '34',
                alt: 'Reflect',
              }),
              /*#__PURE__*/ React.createElement(
                'span',
                {
                  style: {
                    fontSize: 16,
                    fontWeight: 500,
                    color: '#fff',
                  },
                },
                'Reflect',
              ),
            ),
            /*#__PURE__*/ React.createElement(
              'ul',
              {
                style: {
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  gap: 4,
                  listStyle: 'none',
                  margin: 0,
                  padding: 8,
                  borderRadius: 'var(--radius-full)',
                  border: '1px solid var(--glass-border)',
                  background: 'var(--glass-bg)',
                },
              },
              NAV.map((n) =>
                /*#__PURE__*/ React.createElement(
                  'li',
                  {
                    key: n,
                  },
                  /*#__PURE__*/ React.createElement(
                    'a',
                    {
                      style: {
                        display: 'block',
                        padding: '4px 14px',
                        fontSize: 14,
                        color: 'rgba(255,255,255,.9)',
                        cursor: 'pointer',
                      },
                    },
                    n,
                  ),
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 22,
                },
              },
              /*#__PURE__*/ React.createElement(
                'a',
                {
                  style: {
                    fontSize: 14,
                    fontWeight: 500,
                    color: '#fff',
                    cursor: 'pointer',
                  },
                },
                'Login',
              ),
              /*#__PURE__*/ React.createElement(
                Button,
                {
                  variant: 'space',
                },
                'Start free trial',
              ),
            ),
          ),
        )
      }
      function Hero() {
        const { Button } = window[NS_M]
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              position: 'relative',
              textAlign: 'center',
              padding: '70px 24px 30px',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 14px',
                marginBottom: 30,
                borderRadius: 'var(--radius-full)',
                border: '1px solid var(--glass-border)',
                background: 'var(--glass-bg)',
                fontSize: 13,
                color: 'rgba(255,255,255,.8)',
              },
            },
            /*#__PURE__*/ React.createElement(
              'span',
              {
                style: {
                  color: 'var(--purple-light)',
                },
              },
              '\u2726',
            ),
            ' New: Our AI integration just landed',
          ),
          /*#__PURE__*/ React.createElement(
            'h1',
            {
              style: {
                margin: '0 auto',
                maxWidth: 760,
                fontSize: 'var(--display-lg)',
                fontWeight: 600,
                lineHeight: 'var(--leading-tight)',
                letterSpacing: 'var(--tracking-tight)',
                color: '#fff',
              },
            },
            'Think better with Reflect',
          ),
          /*#__PURE__*/ React.createElement(
            'p',
            {
              style: {
                margin: '20px auto 0',
                fontSize: 'var(--text-xl)',
                color: 'rgba(255,255,255,.6)',
              },
            },
            'Never miss a note, idea or connection.',
          ),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                marginTop: 30,
                display: 'flex',
                justifyContent: 'center',
              },
            },
            /*#__PURE__*/ React.createElement(
              Button,
              {
                variant: 'space',
                style: {
                  padding: '12px 22px',
                  fontSize: 15,
                },
              },
              'Start your 14-day trial',
            ),
          ),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                position: 'relative',
                marginTop: 50,
              },
            },
            /*#__PURE__*/ React.createElement('img', {
              src: '../../assets/reflect-graph-hero.png',
              alt: 'A graph of connected notes',
              style: {
                maxWidth: 720,
                width: '90%',
                height: 'auto',
              },
            }),
          ),
        )
      }
      function Features() {
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              maxWidth: 1080,
              margin: '0 auto',
              padding: '60px 28px',
            },
          },
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 28,
              },
            },
            FEATURES.map(([t, d]) =>
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  key: t,
                },
                /*#__PURE__*/ React.createElement('div', {
                  style: {
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    marginBottom: 14,
                    background:
                      'linear-gradient(180deg, rgba(148,101,255,.4), rgba(113,47,255,.15))',
                    border: '1px solid var(--glass-border)',
                  },
                }),
                /*#__PURE__*/ React.createElement(
                  'h3',
                  {
                    style: {
                      margin: '0 0 6px',
                      fontSize: 15,
                      fontWeight: 500,
                      color: '#fff',
                    },
                  },
                  t,
                ),
                /*#__PURE__*/ React.createElement(
                  'p',
                  {
                    style: {
                      margin: 0,
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: 'rgba(255,255,255,.55)',
                    },
                  },
                  d,
                ),
              ),
            ),
          ),
        )
      }
      function AIBanner() {
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              textAlign: 'center',
              padding: '70px 24px',
            },
          },
          /*#__PURE__*/ React.createElement(
            'p',
            {
              style: {
                margin: '0 0 14px',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '.04em',
                color: 'var(--purple-light)',
              },
            },
            'Reflect AI',
          ),
          /*#__PURE__*/ React.createElement(
            'h2',
            {
              style: {
                margin: '0 auto',
                maxWidth: 620,
                fontSize: 'var(--display-sm)',
                fontWeight: 600,
                letterSpacing: 'var(--tracking-tight)',
                lineHeight: 1.15,
                color: '#fff',
              },
            },
            'Notes with an AI assistant',
          ),
          /*#__PURE__*/ React.createElement(
            'p',
            {
              style: {
                margin: '18px auto 0',
                maxWidth: 540,
                fontSize: 17,
                color: 'rgba(255,255,255,.6)',
              },
            },
            'Reflect uses GPT-4 and Whisper from OpenAI to improve your writing, organize your thoughts, and act as your intellectual thought partner.',
          ),
        )
      }
      function Pricing() {
        const { Button } = window[NS_M]
        const incl = [
          'Networked note-taking',
          'Chrome &amp; Safari web clipper',
          'Kindle offline sync',
          'End-to-end encryption',
          'iOS app',
          'Native AI assistant',
        ]
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              padding: '40px 24px 80px',
              textAlign: 'center',
            },
          },
          /*#__PURE__*/ React.createElement(
            'p',
            {
              style: {
                margin: '0 0 12px',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '.04em',
                color: 'var(--purple-light)',
              },
            },
            'Get access',
          ),
          /*#__PURE__*/ React.createElement(
            'h2',
            {
              style: {
                margin: '0 0 36px',
                fontSize: 'var(--display-sm)',
                fontWeight: 600,
                letterSpacing: 'var(--tracking-tight)',
                color: '#fff',
              },
            },
            'One plan, one price',
          ),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                maxWidth: 380,
                margin: '0 auto',
                padding: 32,
                borderRadius: 'var(--radius-2xl)',
                border: '1px solid var(--glass-border)',
                background: 'var(--glass-bg)',
                textAlign: 'left',
                boxShadow: 'inset 0 0 40px rgba(148,101,255,.06)',
              },
            },
            /*#__PURE__*/ React.createElement(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 6,
                  marginBottom: 4,
                },
              },
              /*#__PURE__*/ React.createElement(
                'span',
                {
                  style: {
                    fontSize: 44,
                    fontWeight: 600,
                    color: '#fff',
                    letterSpacing: '-0.02em',
                  },
                },
                '$10',
              ),
              /*#__PURE__*/ React.createElement(
                'span',
                {
                  style: {
                    fontSize: 14,
                    color: 'rgba(255,255,255,.5)',
                  },
                },
                '/month, billed annually',
              ),
            ),
            /*#__PURE__*/ React.createElement(
              'ul',
              {
                style: {
                  listStyle: 'none',
                  margin: '22px 0',
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                },
              },
              incl.map((f) =>
                /*#__PURE__*/ React.createElement(
                  'li',
                  {
                    key: f,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 14,
                      color: 'rgba(255,255,255,.8)',
                    },
                  },
                  /*#__PURE__*/ React.createElement(
                    'span',
                    {
                      style: {
                        color: 'var(--purple-light)',
                      },
                    },
                    '\u2713',
                  ),
                  /*#__PURE__*/ React.createElement('span', {
                    dangerouslySetInnerHTML: {
                      __html: f,
                    },
                  }),
                ),
              ),
            ),
            /*#__PURE__*/ React.createElement(
              Button,
              {
                variant: 'space',
                style: {
                  width: '100%',
                  justifyContent: 'center',
                  padding: '12px',
                },
              },
              'Start your 14-day trial',
            ),
          ),
        )
      }
      function Love() {
        const { Avatar } = window[NS_M]
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              maxWidth: 1000,
              margin: '0 auto',
              padding: '20px 28px 90px',
              textAlign: 'center',
            },
          },
          /*#__PURE__*/ React.createElement(
            'p',
            {
              style: {
                margin: '0 0 12px',
                fontSize: 13,
                fontWeight: 500,
                letterSpacing: '.04em',
                color: 'var(--purple-light)',
              },
            },
            'Wall of love',
          ),
          /*#__PURE__*/ React.createElement(
            'h2',
            {
              style: {
                margin: '0 0 40px',
                fontSize: 'var(--display-sm)',
                fontWeight: 600,
                letterSpacing: 'var(--tracking-tight)',
                color: '#fff',
              },
            },
            'Loved by thinkers',
          ),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 18,
                textAlign: 'left',
              },
            },
            LOVE.map(([name, handle, quote]) =>
              /*#__PURE__*/ React.createElement(
                'div',
                {
                  key: handle,
                  style: {
                    padding: 22,
                    borderRadius: 'var(--radius-xl)',
                    border: '1px solid var(--glass-border)',
                    background: 'var(--glass-bg)',
                  },
                },
                /*#__PURE__*/ React.createElement(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      marginBottom: 12,
                    },
                  },
                  /*#__PURE__*/ React.createElement(Avatar, {
                    name: name,
                    size: 36,
                    style: {
                      background: 'rgba(148,101,255,.18)',
                      color: '#cfb8ff',
                    },
                  }),
                  /*#__PURE__*/ React.createElement(
                    'div',
                    null,
                    /*#__PURE__*/ React.createElement(
                      'div',
                      {
                        style: {
                          fontSize: 14,
                          fontWeight: 600,
                          color: '#fff',
                        },
                      },
                      name,
                    ),
                    /*#__PURE__*/ React.createElement(
                      'div',
                      {
                        style: {
                          fontSize: 12,
                          color: 'rgba(255,255,255,.45)',
                        },
                      },
                      handle,
                    ),
                  ),
                ),
                /*#__PURE__*/ React.createElement(
                  'p',
                  {
                    style: {
                      margin: 0,
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: 'rgba(255,255,255,.72)',
                    },
                  },
                  quote,
                ),
              ),
            ),
          ),
        )
      }
      function CTA() {
        const { Button } = window[NS_M]
        return /*#__PURE__*/ React.createElement(
          'section',
          {
            style: {
              textAlign: 'center',
              padding: '60px 24px 110px',
            },
          },
          /*#__PURE__*/ React.createElement(
            'h2',
            {
              style: {
                margin: '0 auto 24px',
                maxWidth: 560,
                fontSize: 'var(--display-md)',
                fontWeight: 600,
                letterSpacing: 'var(--tracking-tight)',
                lineHeight: 1.1,
                color: '#fff',
              },
            },
            'Think better with Reflect',
          ),
          /*#__PURE__*/ React.createElement(
            Button,
            {
              variant: 'space',
              style: {
                padding: '13px 24px',
                fontSize: 15,
              },
            },
            'Start your 14-day trial',
          ),
        )
      }
      function Site() {
        return /*#__PURE__*/ React.createElement(
          'div',
          {
            className: 'reflect-space',
            style: {
              position: 'relative',
              minHeight: '100%',
              background: 'var(--space-black)',
              overflowX: 'hidden',
            },
          },
          /*#__PURE__*/ React.createElement('div', {
            style: {
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background:
                'radial-gradient(38% 50% at 50% 6%, rgba(148,101,255,.16) 0%, rgba(3,0,20,0) 70%)',
            },
          }),
          /*#__PURE__*/ React.createElement(
            'div',
            {
              style: {
                position: 'relative',
              },
            },
            /*#__PURE__*/ React.createElement(Header, null),
            /*#__PURE__*/ React.createElement(Hero, null),
            /*#__PURE__*/ React.createElement(Features, null),
            /*#__PURE__*/ React.createElement(AIBanner, null),
            /*#__PURE__*/ React.createElement(Pricing, null),
            /*#__PURE__*/ React.createElement(Love, null),
            /*#__PURE__*/ React.createElement(CTA, null),
          ),
        )
      }
      window.SiteKit = {
        Site,
      }
    })()
  } catch (e) {
    __ds_ns.__errors.push({
      path: 'ui_kits/marketing/Site.jsx',
      error: String((e && e.message) || e),
    })
  }

  __ds_ns.Button = __ds_scope.Button

  __ds_ns.IconButton = __ds_scope.IconButton

  __ds_ns.ShortcutKey = __ds_scope.ShortcutKey

  __ds_ns.Avatar = __ds_scope.Avatar

  __ds_ns.Badge = __ds_scope.Badge

  __ds_ns.Card = __ds_scope.Card

  __ds_ns.MenuItem = __ds_scope.MenuItem

  __ds_ns.Checkbox = __ds_scope.Checkbox

  __ds_ns.Input = __ds_scope.Input

  __ds_ns.SearchField = __ds_scope.SearchField

  __ds_ns.Toggle = __ds_scope.Toggle
})()
