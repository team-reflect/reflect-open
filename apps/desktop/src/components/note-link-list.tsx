import type { ReactElement } from 'react'

/** One row in a {@link NoteLinkList}: a note reference with optional context. */
export interface NoteLinkItem {
  /** Stable list identity (a path, or path:position for repeated sources). */
  key: string
  /** The note title shown as the row's main line. */
  title: string
  /** Context line under the title (the linking text, a snippet); `''` hides it. */
  snippet: string
  /** Graph-relative path to navigate to on click. */
  path: string
}

interface NoteLinkListProps {
  /** Accessible name of the section (e.g. "Backlinks", "Related notes"). */
  ariaLabel: string
  /** The section heading text. */
  heading: string
  items: NoteLinkItem[]
  /** Open the clicked note (the host wires this to the router). */
  onOpen: (path: string) => void
}

/**
 * The note-context section under an open note — one presentation shared by
 * backlinks ("Linked from") and semantic neighbors ("Related"), so the two
 * ambient-recall surfaces stay visually identical and panels stay thin query
 * adapters.
 */
export function NoteLinkList({
  ariaLabel,
  heading,
  items,
  onOpen,
}: NoteLinkListProps): ReactElement {
  return (
    <section
      aria-label={ariaLabel}
      className="mt-6 border-t border-black/5 pt-3 dark:border-white/5"
    >
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[color:var(--text-muted)]">
        {heading}
      </h3>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onOpen(item.path)}
              className="w-full rounded px-2 py-1 text-left hover:bg-black/5 dark:hover:bg-white/5"
            >
              <span className="block truncate text-sm font-medium">{item.title}</span>
              {item.snippet !== '' ? (
                <span className="block truncate text-xs text-[color:var(--text-muted)]">
                  {item.snippet}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
