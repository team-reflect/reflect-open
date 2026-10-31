import { useCallback } from 'react'
import { routeForTag } from '@reflect/app'
import { useRouter } from '@/routing/router.tsx'

export type TagNavigation = (tag: string) => void

/**
 * Navigation for a clicked inline `#tag`: open the All Notes screen filtered by
 * that tag. The tag name arrives without its leading `#` (meowdown strips it),
 * and feeds straight into the `allNotes` route's tag facet — the same route the
 * All Notes filter tabs and the chat tag chips already drive.
 *
 * @returns a stable click handler for the note editor's tag extension.
 */
export function useTagNavigation(): TagNavigation {
  const { navigate } = useRouter()

  return useCallback(
    (tag) => {
      navigate(routeForTag(tag))
    },
    [navigate],
  )
}
