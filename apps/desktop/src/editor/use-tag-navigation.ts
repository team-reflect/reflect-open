import { useCallback } from 'react'
import { useRouter } from '@/routing/router'

/**
 * Navigation for a clicked inline `#tag`: open the All Notes screen filtered by
 * that tag. The tag name arrives without its leading `#` (meowdown strips it),
 * and feeds straight into the `allNotes` route's tag facet — the same route the
 * All Notes filter tabs and the chat tag chips already drive.
 *
 * @returns a stable click handler for the note editor's tag extension.
 */
export function useTagNavigation(): (tag: string) => void {
  const { navigate } = useRouter()

  return useCallback(
    (tag: string) => {
      navigate({ kind: 'allNotes', tag })
    },
    [navigate],
  )
}
