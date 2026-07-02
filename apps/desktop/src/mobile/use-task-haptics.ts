import { useEffect } from 'react'
import { hapticImpactLight } from '@/mobile/haptics'

/**
 * A light haptic tick when a task checkbox is toggled in the editor (V1 mobile
 * parity — Plan 19). meowdown's task lists (prosemirror-flat-list) toggle on
 * `mousedown` over the list marker, so one delegated document listener covers
 * every mounted editor: the note screen, the day carousel, and anything later.
 * Only markers of `task`-kind lists inside a live (contenteditable) surface
 * count — toggle-fold chevrons and read-only protected views stay silent.
 */
export function useTaskCheckboxHaptics(): void {
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) {
        return
      }
      const marker = target.closest(
        '.prosemirror-flat-list[data-list-kind="task"] > .list-marker-click-target',
      )
      if (marker === null || marker.closest('[contenteditable="true"]') === null) {
        return
      }
      hapticImpactLight()
    }
    document.addEventListener('mousedown', onMouseDown, true)
    return () => document.removeEventListener('mousedown', onMouseDown, true)
  }, [])
}
