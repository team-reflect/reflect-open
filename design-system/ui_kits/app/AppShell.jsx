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

  const titles = { daily: 'Daily notes', all: 'All notes', tasks: 'Tasks', map: 'Map' }
  const View = { daily: DailyNotes, all: AllNotes, tasks: Tasks, map: MapView }[screen]

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        background: 'var(--surface)',
        overflow: 'hidden',
      }}
    >
      <Sidebar
        screen={screen}
        onNavigate={(s) => {
          setScreen(s)
          setSelectedNote(null)
        }}
        onOpenSearch={() => setSearch(true)}
        pinned={['Morning routine', 'Reading', 'Weekly review']}
        selectedNote={selectedNote}
        onOpenNote={openNote}
      />
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          position: 'relative',
        }}
      >
        <View onOpenNote={openNote} key={screen} />
      </main>
      <SearchModal open={search} onClose={() => setSearch(false)} onOpenNote={openNote} />
    </div>
  )
}

window.AppKit = Object.assign(window.AppKit || {}, { AppShell })
