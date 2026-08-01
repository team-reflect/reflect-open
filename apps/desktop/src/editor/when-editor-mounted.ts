/** How many animation frames to wait for ProseKit to attach the editor view
 *  before giving up. In practice the view is attached via ref before effects
 *  run, so the first synchronous check succeeds and no frame is ever
 *  scheduled; half a second of misses means something is genuinely broken. */
const MOUNT_RETRY_FRAMES = 30

/**
 * Run `run` once `editor.mounted` is true — synchronously when the view is
 * already attached (the ordinary case: ProseKit attaches via ref before
 * effects run), else retrying once per animation frame. The retry is bounded
 * to {@link MOUNT_RETRY_FRAMES}: the mount timing is ProseKit's, not ours,
 * and an editor that never mounts must log an error and stop rather than
 * spin at display refresh rate for the component's lifetime.
 *
 * Returns a cancel function for effect cleanup; canceling after `run` has
 * fired (or after the budget lapsed) is a no-op.
 */
export function whenEditorMounted(
  editor: { readonly mounted: boolean },
  run: () => void,
): () => void {
  let frame: number | null = null
  let attempts = 0
  const check = (): void => {
    if (editor.mounted) {
      frame = null
      run()
      return
    }
    if (attempts === MOUNT_RETRY_FRAMES) {
      frame = null
      console.error(`editor view never mounted; gave up after ${MOUNT_RETRY_FRAMES} frames`)
      return
    }
    attempts += 1
    frame = requestAnimationFrame(check)
  }
  check()
  return () => {
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
  }
}
