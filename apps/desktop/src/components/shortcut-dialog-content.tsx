import type { ReactElement } from 'react'
import { ShortcutList } from '@/components/shortcut-list'
import { APP_SHORTCUTS, EDITOR_SHORTCUTS } from '@/lib/shortcuts'

/** The shortcut registries presented inside the keyboard cheat-sheet. */
export function ShortcutDialogContent(): ReactElement {
  return (
    <div className="min-h-0 overflow-y-auto pr-1">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)] xl:grid-cols-[minmax(14rem,1fr)_minmax(0,3fr)]">
        <ShortcutList heading="App" shortcuts={APP_SHORTCUTS} />
        <ShortcutList
          heading="Editor"
          shortcuts={EDITOR_SHORTCUTS}
          listClassName="lg:columns-2 xl:columns-3 lg:gap-8"
        />
      </div>
    </div>
  )
}
