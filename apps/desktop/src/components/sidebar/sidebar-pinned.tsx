import type { ReactElement } from 'react'
import { usePinnedNotes } from '@/hooks/use-pinned-notes'
import { SidebarNoteRow } from './sidebar-note-row'

/**
 * The sidebar's Pinned section (the original app's "Pinned notes" shelf):
 * every note carrying `pinned: true` frontmatter, title-ordered, above the
 * Recents feed. Hidden entirely while nothing is pinned — an empty shelf is
 * sidebar noise, not an affordance.
 */
export function SidebarPinned(): ReactElement | null {
  const pinned = usePinnedNotes()

  if (pinned.length === 0) {
    return null
  }

  return (
    <section aria-label="Pinned notes">
      <h2 className="px-4 pt-4 text-2xs font-medium leading-5 tracking-wide text-text-muted">
        Pinned notes
      </h2>
      <ul className="mt-2 flex flex-col space-y-1">
        {pinned.map((note) => (
          <SidebarNoteRow
            key={note.path}
            path={note.path}
            title={note.title}
            date={note.dailyDate}
          />
        ))}
      </ul>
    </section>
  )
}
