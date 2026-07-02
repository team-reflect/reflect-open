import { useState, type ReactElement } from 'react'
import { isUntitledNotePath } from '@reflect/core'
import { ChevronLeft } from 'lucide-react'
import { NotePane } from '@/components/note-pane'
import { Button } from '@/components/ui/button'
import { IncomingBacklinks } from '@/mobile/incoming-backlinks'
import { NoteActionsMenu } from '@/mobile/note-actions-menu'
import { useRouter } from '@/routing/router'

/**
 * One note, opened from a wiki link, the new-note button, or (later) search
 * (Plan 19). Lazy like the desktop note route, so a link to a not-yet-created
 * note opens an empty editor and the file is born on the first keystroke; a
 * fresh untitled note (`+`, V1 parity) autofocuses so the keyboard is up and
 * typing names it via the ghost-title flow. A wiki-link or backlink tap
 * arrives with the router's `focusEditor` intent, so the destination restores
 * focus too (the mobile focus contract) — while a plain arrival (All list,
 * back) never raises the keyboard. Back pops the history stack; a cold entry
 * (nothing to pop) lands on today instead.
 */
export function MobileNote({ path }: { path: string }): ReactElement {
  const { back, canBack, navigate, arrivalFocusEditor } = useRouter()
  const untitled = isUntitledNotePath(path)
  // Latched at mount (the screen is keyed by path, so a mount IS the
  // arrival): the editor appears only after the document loads, and by then
  // a background navigation could have rewritten the arrival intent.
  const [focusRequested] = useState(arrivalFocusEditor)

  return (
    <div className="flex h-full w-screen flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-1 pb-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-10"
          aria-label="Back"
          onClick={() => (canBack ? back() : navigate({ kind: 'today' }))}
        >
          <ChevronLeft />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {untitled ? 'New note' : noteTitleFromPath(path)}
        </h1>
        <NoteActionsMenu
          path={path}
          onDeleted={() => (canBack ? back() : navigate({ kind: 'today' }))}
        />
      </header>
      <main
        className="min-h-0 flex-1 overflow-y-auto"
        // Keyboard avoidance is the shell root's job (it ends at the
        // keyboard's top); this only clears the home indicator when the
        // keyboard is down.
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <NotePane
          path={path}
          lazy
          autoFocus={untitled || focusRequested}
          showBacklinks={false}
          gutterClassName="px-4"
          editorClassName="min-h-[60dvh]"
        />
        {/* The mobile section (touch chrome) replaces NotePane's built-in
            desktop panel; a daily-note backlink opens the Daily surface at
            that date rather than pushing another note screen. */}
        <IncomingBacklinks path={path} className="px-4 pb-4" />
      </main>
    </div>
  )
}

/** Readable filenames (Plan 17) make the basename the working title. */
function noteTitleFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
