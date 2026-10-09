import { useEffect, useState } from 'react'
import { isApplePlatform } from '@/lib/keybindings.ts'

/**
 * How long `Mod` must be held alone before hints appear. Long enough that a
 * quick chord (⌘S, ⌘K) never flashes them, short enough to feel immediate
 * when the user pauses to look.
 */
export const MOD_KEY_REVEAL_DELAY_MS = 300

/**
 * True while the platform's `Mod` key (⌘ on Apple, Ctrl elsewhere) is held
 * on its own, for surfaces that reveal their number shortcuts on demand.
 * Another modifier or key pressed before the reveal delay makes it a chord
 * and cancels the reveal; releasing `Mod`, or the window losing focus (which
 * swallows the keyup), hides the hints again.
 */
export function useModKeyHeld(): boolean {
  const [held, setHeld] = useState(false)

  useEffect(() => {
    const apple = isApplePlatform()
    const modKey = apple ? 'Meta' : 'Control'
    let revealTimer: number | null = null

    function cancelReveal(): void {
      if (revealTimer !== null) {
        window.clearTimeout(revealTimer)
        revealTimer = null
      }
    }

    function release(): void {
      cancelReveal()
      setHeld(false)
    }

    function onKeyDown(event: KeyboardEvent): void {
      const modDown = apple ? event.metaKey : event.ctrlKey
      if (event.key === modKey) {
        const otherModifier =
          event.shiftKey || event.altKey || (apple ? event.ctrlKey : event.metaKey)
        if (!event.repeat && !otherModifier && revealTimer === null) {
          revealTimer = window.setTimeout(() => {
            revealTimer = null
            setHeld(true)
          }, MOD_KEY_REVEAL_DELAY_MS)
        }
        return
      }
      cancelReveal()
      if (!modDown) {
        setHeld(false) // a missed keyup (e.g. released over another app)
      }
    }

    function onKeyUp(event: KeyboardEvent): void {
      if (event.key === modKey) {
        release()
      }
    }

    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        release()
      }
    }

    // Capture phase: the focused editor may stop propagation of the keys it
    // handles, and the hints must still see every Mod press and release.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelReveal()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  return held
}
