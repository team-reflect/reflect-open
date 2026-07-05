import { useState, type ReactElement } from 'react'
import { isUntitledNotePath } from '@reflect/core'
import { NotePane } from '@/components/note-pane'
import { IncomingBacklinks } from '@/mobile/incoming-backlinks'
import { MOBILE_CONTENT_GUTTER } from '@/mobile/mobile-content-gutter'
import { MobileScreenHeader } from '@/mobile/screen-header'
import { NoteActionsMenu } from '@/mobile/note-actions-menu'
import { cn } from '@/lib/utils'
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
      <MobileScreenHeader
        title={untitled ? 'New note' : 'Edit note'}
        onBack={() => (canBack ? back() : navigate({ kind: 'today' }))}
        trailing={
          <NoteActionsMenu
            path={path}
            onDeleted={() => (canBack ? back() : navigate({ kind: 'today' }))}
          />
        }
      />
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
          // The daily surface gets its top inset from the date header; a
          // plain note has no chrome between the header bar and the body,
          // so the pane carries the vertical breathing room itself.
          className="pt-4"
          gutterClassName={MOBILE_CONTENT_GUTTER}
          editorClassName="min-h-[60dvh]"
        />
        {/* The mobile section (touch chrome) replaces NotePane's built-in
            desktop panel; a daily-note backlink opens the Daily surface at
            that date rather than pushing another note screen. */}
        <IncomingBacklinks path={path} className={cn(MOBILE_CONTENT_GUTTER, 'pb-4')} />
      </main>
    </div>
  )
}
