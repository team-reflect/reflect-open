import { onTestFinished } from 'vitest'
import { emulateMedia } from 'vitest-browser-commands/playwright'

const QUERY = '(prefers-reduced-motion: reduce)'
const initialReduce = window.matchMedia(QUERY).matches

/**
 * Emulates `prefers-reduced-motion` for the running test. When the test
 * finishes, the browser gets back the value it had when this module loaded.
 */
export async function emulateReducedMotion(reduce: boolean): Promise<void> {
  onTestFinished(async () => {
    await emulateMedia({ reducedMotion: initialReduce ? 'reduce' : 'no-preference' })
  })
  await emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' })
}
