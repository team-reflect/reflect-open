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
    { icon: <I.Pencil size={15} />, label: 'Jump to today', meta: 'Daily notes' },
    { icon: <I.Sparkles size={15} />, label: 'Ask Reflect AI…', meta: 'AI' },
    { icon: <I.List size={15} />, label: 'Morning routine', meta: 'Note' },
    { icon: <I.List size={15} />, label: 'Design sync', meta: 'Note' },
    { icon: <I.Calendar size={15} />, label: 'The Beginning of Infinity', meta: 'Note' },
  ].filter((r) => r.label.toLowerCase().includes(q.toLowerCase()))

  return (
    <div
      onMouseDown={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '14vh',
        background: 'rgba(11,19,36,.28)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <Card
        elevated
        padding={0}
        onClick={(e) => e.stopPropagation?.()}
        style={{ width: 560, maxWidth: '88%', overflow: 'hidden' }}
      >
        <div onMouseDown={(e) => e.stopPropagation()}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '14px 16px',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <I.Search size={18} style={{ color: 'var(--text-muted)' }} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search anything…"
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-lg)',
                color: 'var(--text)',
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '2px 6px',
              }}
            >
              esc
            </span>
          </div>
          <div style={{ padding: 8, maxHeight: 320, overflowY: 'auto' }}>
            {results.length === 0 && (
              <div style={{ padding: '18px 12px', color: 'var(--text-muted)', fontSize: 14 }}>
                No results for “{q}”.
              </div>
            )}
            {results.map((r, i) => (
              <div
                key={i}
                onMouseDown={() => {
                  onOpenNote(r.label)
                  onClose()
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '9px 12px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'default',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: 'var(--text-secondary)', display: 'flex' }}>{r.icon}</span>
                <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text)' }}>
                  {r.label}
                </span>
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                  {r.meta}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}

window.AppKit = Object.assign(window.AppKit || {}, { SearchModal })
