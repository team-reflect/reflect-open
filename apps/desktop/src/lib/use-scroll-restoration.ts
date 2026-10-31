import { useEffect, type UIEvent } from 'react'
import { useRouter } from '@/routing/router.tsx'

/**
 * Per-entry scroll memory for a route that owns its own scroll container — the
 * All Notes / Tasks shape, not `ScrollRestored`'s. Restores the saved offset on
 * back/forward and resets to the top on re-arrival (the router clears the offset
 * for that case, so `arrivalSeq` re-runs the effect). `ready` gates the restore
 * on the content being loaded: restoring against an empty, zero-height container
 * would clamp the offset to 0 and lose the position.
 *
 * Takes the scroll element itself (not a ref) so the restore re-runs once it
 * mounts — a virtualized container already holds it in state for its virtualizer,
 * and a plain one can with a callback ref. Returns the `onScroll` handler to put
 * on the scroll container.
 */
export function useScrollRestoration(
  element: HTMLElement | null,
  ready: boolean,
): { onScroll: (event: UIEvent<HTMLElement>) => void } {
  const { arrivalSeq, entryId, saveScrollState, savedScroll } = useRouter()
  useEffect(() => {
    if (ready && element) {
      // Setting scrollTop is a DOM side effect inside an effect; the rule treats
      // the `element` argument as immutable, but mutating the live DOM node here
      // is intentional.
      // eslint-disable-next-line react-hooks/immutability
      element.scrollTop = savedScroll() ?? 0
    }
  }, [arrivalSeq, entryId, ready, savedScroll, element])
  return {
    onScroll: (event) => saveScrollState(event.currentTarget.scrollTop),
  }
}
