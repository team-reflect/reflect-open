import { type ReactElement } from 'react'
import { ChevronLeft } from 'lucide-react'
import { NotePane } from '@/components/note-pane'
import { Button } from '@/components/ui/button'
import { isUntitledNotePath } from '@/lib/create-note'
import { NoteActionsMenu } from '@/mobile/note-actions-menu'
import { useRouter } from '@/routing/router'

/**
 * One note, opened from a wiki link, the new-note button, or (later) search
 * (Plan 19). Lazy like the desktop note route, so a link to a not-yet-created
 * note opens an empty editor and the file is born on the first keystroke; a
 * fresh untitled note (`+`, V1 parity) autofocuses so the keyboard is up and
 * typing names it via the ghost-title flow. Back pops the history stack; a
 * cold entry (nothing to pop) lands on today instead.
 */
export function MobileNote({ path }: { path: string }): ReactElement {
  const { back, canBack, navigate } = useRouter()
  const untitled = isUntitledNotePath(path)

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
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), var(--keyboard-height, 0px))' }}
      >
        <NotePane
          path={path}
          lazy
          autoFocus={untitled}
          gutterClassName="px-4"
          editorClassName="min-h-[60dvh]"
        />
      </main>
    </div>
  )
}

/** Readable filenames (Plan 17) make the basename the working title. */
function noteTitleFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.endsWith('.md') ? base.slice(0, -'.md'.length) : base
}
