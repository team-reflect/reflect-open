import { useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, X } from 'lucide-react'
import { Input } from '@/components/ui/input.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { useNoteAliases } from '@/lib/use-note-aliases.ts'
import { SidebarSection } from './sidebar-section.tsx'
import { rejectAlias, type AliasRejection } from '@reflect/core'

interface NoteAliasesSectionProps {
  /** Graph-relative path of the note whose aliases to list and edit. */
  path: string
  /** Whether the add-alias input is showing (opened from Note actions). */
  isAdding: boolean
  /** Close the add-alias input (after a confirm, Escape, or an empty Enter). */
  onAddingDone: () => void
}

const REJECTION_MESSAGES: Record<Exclude<AliasRejection, 'empty'>, string> = {
  invalid: 'Aliases can’t contain [, ], | or //',
  duplicate: 'This note already has that name',
}

const ROW_CLASS_NAME =
  'group flex w-full items-center space-x-1 rounded-md px-3 py-1 leading-5 text-text-secondary hover:bg-surface-hover hover:text-text'

/**
 * "Note aliases" as a context-sidebar section: every name the note answers to
 * besides its title. Frontmatter aliases carry a hover remove action; `//`
 * title segments are listed too but are edited in the H1 itself. Renders
 * nothing when the note has no aliases and no add is in progress.
 */
export function NoteAliasesSection({
  path,
  isAdding,
  onAddingDone,
}: NoteAliasesSectionProps): ReactElement | null {
  const { aliases, add, remove } = useNoteAliases(path)
  const [draft, setDraft] = useState('')
  const [rejection, setRejection] = useState<AliasRejection | null>(null)

  if (aliases === undefined) {
    return null
  }
  const hasAliases = aliases.frontmatter.length > 0 || aliases.fromTitle.length > 0
  if (!hasAliases && !isAdding) {
    return null
  }

  const close = (): void => {
    setDraft('')
    setRejection(null)
    onAddingDone()
  }

  const confirm = (): void => {
    const reason = rejectAlias(draft, aliases)
    if (reason === 'empty') {
      close()
      return
    }
    if (reason !== null) {
      setRejection(reason)
      return
    }
    void add(draft)
    close()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      confirm()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  return (
    <SidebarSection storageKey="note-aliases" title="Note aliases">
      <ul className="space-y-1">
        {aliases.frontmatter.map((alias, index) => (
          <li key={`frontmatter:${index}:${alias}`} className={ROW_CLASS_NAME}>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">{alias}</span>
            <button
              type="button"
              aria-label={`Remove alias ${alias}`}
              onClick={() => void remove(alias)}
              className="flex-none text-text-muted opacity-0 group-hover:opacity-100 hover:text-text focus-visible:opacity-100"
            >
              <X aria-hidden width={13} height={13} />
            </button>
          </li>
        ))}
        {aliases.fromTitle.map((alias) => (
          <li key={`title:${alias}`}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <div className={ROW_CLASS_NAME}>
                    <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
                      {alias}
                    </span>
                    <span className="flex-none text-2xs text-text-muted">{'//'}</span>
                  </div>
                }
              />
              <TooltipContent>From the title — edit the title to change it</TooltipContent>
            </Tooltip>
          </li>
        ))}
        {isAdding ? (
          <li>
            <div className="flex items-center space-x-1 px-1">
              <Input
                autoFocus
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setRejection(null)
                }}
                onKeyDown={onKeyDown}
                placeholder="New alias"
                aria-label="New alias"
                aria-invalid={rejection !== null && rejection !== 'empty'}
                className="h-7 min-w-0 flex-1 px-2 text-xs"
              />
              <button
                type="button"
                aria-label="Add alias"
                onClick={confirm}
                className="flex size-6 flex-none items-center justify-center rounded-md text-text-muted hover:bg-surface-hover hover:text-text"
              >
                <Check aria-hidden width={13} height={13} />
              </button>
            </div>
            {rejection !== null && rejection !== 'empty' ? (
              <p className="px-3 pt-1 text-2xs text-text-muted">{REJECTION_MESSAGES[rejection]}</p>
            ) : null}
          </li>
        ) : null}
      </ul>
    </SidebarSection>
  )
}
