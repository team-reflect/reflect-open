import { useSyncExternalStore, type ReactElement } from 'react'
import { FileText } from 'lucide-react'
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  ambiguousNoteChoiceSnapshot,
  settleAmbiguousNoteChoice,
  subscribeAmbiguousNoteChoice,
} from './ambiguous-note-chooser-store'

function labelForPath(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

function parentForPath(path: string): string {
  const segments = path.split('/')
  segments.pop()
  return segments.length === 0 ? 'Vault root' : segments.join('/')
}

/** Keyboard-native path chooser shown only when duplicate note matches exist. */
export function AmbiguousNoteChooser(): ReactElement | null {
  const choice = useSyncExternalStore(
    subscribeAmbiguousNoteChoice,
    ambiguousNoteChoiceSnapshot,
    ambiguousNoteChoiceSnapshot,
  )
  if (choice === null) return null

  return (
    <CommandDialog
      open
      onOpenChange={(open) => {
        if (!open) settleAmbiguousNoteChoice(null)
      }}
      title={`Choose “${choice.title}”`}
      description="Several notes match this link. Choose one by its vault path."
    >
      <CommandInput placeholder="Filter matching paths…" />
      <CommandList>
        <CommandGroup heading="Matching notes">
          {choice.paths.map((path) => (
            <CommandItem
              key={path}
              value={`${labelForPath(path)} ${path}`}
              onSelect={() => settleAmbiguousNoteChoice(path)}
            >
              <FileText aria-hidden strokeWidth={1.75} className="text-text-muted" />
              <span className="min-w-0 flex-1 truncate">{labelForPath(path)}</span>
              <span className="max-w-1/2 truncate text-xs text-text-muted">
                {parentForPath(path)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
