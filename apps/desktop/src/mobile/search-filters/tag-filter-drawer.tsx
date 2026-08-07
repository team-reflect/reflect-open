import type { ReactElement } from 'react'
import { Check } from 'lucide-react'
import { foldTag, type NoteTagFacet } from '@reflect/core'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'

interface TagFilterDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every tag in the graph (display casing + note count). */
  facets: NoteTagFacet[]
  /** The selected folded tag keys. */
  selected: string[]
  /** Toggle one folded tag key in or out of the selection. */
  onToggle: (tagKey: string) => void
}

/**
 * The Tags badge's multi-select picker (V1's tag modal as a bottom sheet):
 * every tag with its note count, checkmarks on the selected set. Selection is
 * ANDed — each added tag narrows the list further.
 */
export function TagFilterDrawer({
  open,
  onOpenChange,
  facets,
  selected,
  onToggle,
}: TagFilterDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerTitle>Tags</DrawerTitle>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {facets.length === 0 && (
            <p className="py-6 text-center text-sm text-text-muted">No tags yet</p>
          )}
          {facets.map((facet) => {
            const key = foldTag(facet.tag)
            const isSelected = selected.includes(key)
            return (
              <button
                key={key}
                type="button"
                onClick={() => onToggle(key)}
                className="flex h-12 w-full items-center gap-3 border-b border-border text-left text-base last:border-b-0"
              >
                <span className={cn('min-w-0 flex-1 truncate', isSelected && 'font-medium')}>
                  #{facet.tag}
                </span>
                <span className="text-xs text-text-muted">{facet.count}</span>
                {isSelected && <Check className="size-4 text-primary" />}
              </button>
            )
          })}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
