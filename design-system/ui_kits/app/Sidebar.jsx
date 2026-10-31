/* Reflect app — left sidebar. Composes SearchField, IconButton, MenuItem,
   ShortcutKey, Avatar from the design system bundle. */
const NS = 'ReflectDesignSystem_06b075'

function Sidebar({ screen, onNavigate, onOpenSearch, pinned, selectedNote, onOpenNote }) {
  const { SearchField, IconButton, MenuItem, ShortcutKey, Avatar } = window[NS]
  const I = window.RIcons

  const nav = [
    { key: 'daily', label: 'Daily notes', icon: <I.Pencil />, sc: 'mod+shift+d' },
    { key: 'all', label: 'All notes', icon: <I.List />, sc: 'mod+shift+a' },
    { key: 'tasks', label: 'Tasks', icon: <I.Check />, sc: 'mod+shift+t' },
    { key: 'map', label: 'Map', icon: <I.Map />, sc: 'mod+shift+m' },
  ]

  return (
    <aside
      style={{
        width: 260,
        flex: 'none',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-sunken)',
        borderRight: '1px solid var(--border)',
      }}
    >
      {/* traffic lights */}
      <div style={{ display: 'flex', gap: 8, padding: '14px 16px 0' }}>
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#ff5f57' }} />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#febc2e' }} />
        <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#28c840' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: '18px 0' }}>
        <div style={{ display: 'flex', gap: 8, padding: '0 16px' }}>
          <SearchField onClick={onOpenSearch} />
          <IconButton label="Record audio">
            <I.Mic size={16} />
          </IconButton>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 12px' }}>
          {nav.map((n) => (
            <MenuItem
              key={n.key}
              icon={n.icon}
              selected={screen === n.key}
              shortcut={<ShortcutKey shortcut={n.sc} />}
              onClick={() => onNavigate(n.key)}
            >
              {n.label}
            </MenuItem>
          ))}
        </nav>

        <div style={{ padding: '0 16px' }}>
          <h3
            style={{
              margin: '0 0 8px',
              fontSize: 'var(--text-xs)',
              fontWeight: 500,
              letterSpacing: 'var(--tracking-wide)',
              color: 'var(--text-muted)',
            }}
          >
            Pinned notes
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {pinned.map((p) => {
              const sel = selectedNote === p
              return (
                <div
                  key={p}
                  onMouseDown={() => onOpenNote(p)}
                  style={{
                    padding: '4px 8px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'default',
                    fontSize: 'var(--text-2xs)',
                    fontWeight: 500,
                    color: sel ? 'var(--text)' : 'var(--text-secondary)',
                    background: sel ? 'var(--surface-hover)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!sel) e.currentTarget.style.background = 'var(--surface-hover)'
                  }}
                  onMouseLeave={(e) => {
                    if (!sel) e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {p}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      {/* account nav */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px',
          borderTop: '1px solid var(--border)',
          cursor: 'default',
        }}
      >
        <Avatar graphColor="#4F46E5" size={30} />
        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--text)' }}>
          My Graph
        </span>
        <span style={{ flex: 1 }} />
        <window.RIcons.ChevronDown size={14} style={{ color: 'var(--text-muted)' }} />
      </div>
    </aside>
  )
}

window.AppKit = Object.assign(window.AppKit || {}, { Sidebar })
