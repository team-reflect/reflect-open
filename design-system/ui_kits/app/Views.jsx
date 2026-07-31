/* Reflect app — main content views. The daily-notes editor is the home
   surface: date-titled blocks of bulleted prose with backlinks & tags. */
const NS_V = 'ReflectDesignSystem_06b075'

/* --- inline editor primitives ------------------------------------ */
const Backlink = ({ children, onClick }) => (
  <span
    onMouseDown={onClick}
    style={{
      color: 'var(--accent)',
      cursor: 'pointer',
      fontWeight: 500,
      boxShadow: 'inset 0 -1px 0 color-mix(in srgb, var(--accent) 35%, transparent)',
    }}
  >
    {children}
  </span>
)
const Tag = ({ children }) => (
  <span
    style={{
      color: 'var(--accent)',
      background: 'var(--accent-soft)',
      borderRadius: 'var(--radius-sm)',
      padding: '0 5px',
      fontWeight: 500,
      fontSize: '0.92em',
    }}
  >
    #{children}
  </span>
)
const Bullet = ({ children, style }) => (
  <li
    style={{
      position: 'relative',
      paddingLeft: 22,
      marginBottom: 7,
      fontSize: 'var(--text-base)',
      lineHeight: 'var(--leading-relaxed)',
      color: 'var(--text)',
      ...style,
    }}
  >
    <span
      style={{
        position: 'absolute',
        left: 6,
        top: '0.62em',
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: 'var(--coolgray-400)',
      }}
    />
    {children}
  </li>
)

function EditorTask({ text, done0 }) {
  const { Checkbox } = window[NS_V]
  const [done, setDone] = React.useState(done0)
  return (
    <li style={{ listStyle: 'none', marginBottom: 7, marginLeft: -2 }}>
      <Checkbox checked={done} label={text} onChange={setDone} />
    </li>
  )
}

const measure = {
  width: '100%',
  maxWidth: 'var(--editor-measure)',
  margin: '0 auto',
  padding: '0 56px',
}

function DayBlock({ date, tense, onOpenNote, children }) {
  return (
    <section style={{ borderBottom: '1px solid var(--border)', padding: '32px 0' }}>
      <div style={measure}>
        <h1
          style={{
            margin: '0 0 16px',
            fontSize: 'var(--text-2xl)',
            fontWeight: 600,
            letterSpacing: 'var(--tracking-tight)',
            color: tense === 'today' ? 'var(--accent)' : 'var(--text)',
          }}
        >
          {date}
        </h1>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>{children}</ul>
      </div>
    </section>
  )
}

function DailyNotes({ onOpenNote }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <DayBlock date="Today · Tuesday, June 8" tense="today" onOpenNote={onOpenNote}>
        <Bullet>
          Morning pages — felt clear after a walk. Linking back to{' '}
          <Backlink onClick={() => onOpenNote('Morning routine')}>Morning routine</Backlink>.
        </Bullet>
        <EditorTask text="Finish the Reflect design system" done0={false} />
        <EditorTask text="Review PR on the editor" done0={true} />
        <Bullet>
          Idea: a weekly review template. <Tag>ideas</Tag> <Tag>productivity</Tag>
        </Bullet>
        <Bullet>
          Meeting notes from{' '}
          <Backlink onClick={() => onOpenNote('Design sync')}>Design sync</Backlink> — ship the new
          onboarding.
        </Bullet>
      </DayBlock>

      <DayBlock date="Monday, June 7" tense="past" onOpenNote={onOpenNote}>
        <Bullet>
          Read two chapters of{' '}
          <Backlink onClick={() => onOpenNote('The Beginning of Infinity')}>
            The Beginning of Infinity
          </Backlink>
          . Good explanations are hard to vary.
        </Bullet>
        <Bullet>
          Called Mum. <Tag>family</Tag>
        </Bullet>
        <EditorTask text="Book dentist" done0={false} />
      </DayBlock>

      <DayBlock date="Sunday, June 6" tense="past" onOpenNote={onOpenNote}>
        <Bullet>
          Quiet day. Captured a few highlights from Kindle into{' '}
          <Backlink onClick={() => onOpenNote('Reading')}>Reading</Backlink>.
        </Bullet>
      </DayBlock>
    </div>
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
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
      <div style={measure}>
        <h1
          style={{
            margin: '0 0 4px',
            fontSize: 'var(--text-2xl)',
            fontWeight: 600,
            letterSpacing: 'var(--tracking-tight)',
          }}
        >
          All notes
        </h1>
        <p style={{ margin: '0 0 22px', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
          142 notes
        </p>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {notes.map(([t, d, time]) => (
            <div
              key={t}
              onMouseDown={() => onOpenNote(t)}
              style={{
                padding: '14px 12px',
                borderTop: '1px solid var(--border)',
                cursor: 'default',
                borderRadius: 8,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <span
                  style={{ fontSize: 'var(--text-base)', fontWeight: 500, color: 'var(--text)' }}
                >
                  {t}
                </span>
                <span
                  style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', flex: 'none' }}
                >
                  {time}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>
                {d}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
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
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '32px 0' }}>
      <div style={measure}>
        <h1
          style={{
            margin: '0 0 22px',
            fontSize: 'var(--text-2xl)',
            fontWeight: 600,
            letterSpacing: 'var(--tracking-tight)',
          }}
        >
          Tasks
        </h1>
        {groups.map(([g, items]) => (
          <div key={g} style={{ marginBottom: 26 }}>
            <h3
              style={{
                margin: '0 0 12px',
                fontSize: 'var(--text-xs)',
                fontWeight: 500,
                letterSpacing: 'var(--tracking-wide)',
                color: 'var(--text-muted)',
              }}
            >
              {g}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {items.map(([t, d], i) => (
                <TaskRow key={i} text={t} done0={d} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
function TaskRow({ text, done0 }) {
  const { Checkbox } = window[NS_V]
  const [done, setDone] = React.useState(done0)
  return (
    <Checkbox
      checked={done}
      label={text}
      onChange={setDone}
      style={{ fontSize: 'var(--text-base)' }}
    />
  )
}

function MapView() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <img
        src="../../assets/reflect-graph-hero.png"
        alt="Knowledge graph"
        style={{ maxWidth: '70%', height: 'auto', opacity: 0.96 }}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 28,
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
        }}
      >
        Your notes, connected — 142 nodes
      </div>
    </div>
  )
}

window.AppKit = Object.assign(window.AppKit || {}, { DailyNotes, AllNotes, Tasks, MapView })
