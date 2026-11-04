import { useEffect, type RefObject, type UIEvent } from 'react'
import { useRouter } from '@/routing/router.tsx'

/**
 * Per-entry scroll memory for a route that owns its own scroll container — the
 * All Notes / Tasks shape, not `ScrollRestored`'s. Restores the saved offset on
 * back/forward and resets to the top on re-arrival (the router clears the offset
 * for that case, so `arrivalSeq` re-runs the effect). `ready` gates the restore
 * on the content being loaded: restoring against an empty, zero-height container
 * would clamp the offset to 0 and lose the position.
 *
 * The scroll container behind `elementRef` must stay mounted while the route
 * renders: a mount or swap alone does not re-run the restore. Returns the
 * `onScroll` handler to put on the scroll container.
 */
export function useScrollRestoration(
  elementRef: RefObject<HTMLElement | null>,
  ready: boolean,
): { onScroll: (event: UIEvent<HTMLElement>) => void } {
  const { arrivalSeq, entryId, saveScrollState, savedScroll } = useRouter()
  useEffect(() => {
    const element = elementRef.current
    if (ready && element) {
      const saved = savedScroll()
      element.scrollTop = typeof saved === 'number' ? saved : 0
    }
  }, [arrivalSeq, entryId, ready, savedScroll, elementRef])
  return {
    onScroll: (event) => saveScrollState(event.currentTarget.scrollTop),
  }
}
