import { afterEach, describe, expect, it, vi } from 'vitest'
import { whenEditorMounted } from './when-editor-mounted'

/**
 * Frame scheduling is driven by hand: `requestAnimationFrame` pushes into a
 * queue the test drains one frame at a time, so the retry budget is exact
 * rather than timing-dependent.
 */
function fakeFrames(): { step: () => boolean; canceled: () => number } {
  const queue: FrameRequestCallback[] = []
  let nextHandle = 1
  let canceled = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    queue.push(callback)
    return nextHandle++
  })
  vi.stubGlobal('cancelAnimationFrame', (): void => {
    canceled += 1
  })
  return {
    step: () => {
      const frame = queue.shift()
      if (frame === undefined) {
        return false
      }
      frame(0)
      return true
    },
    canceled: () => canceled,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('whenEditorMounted', () => {
  it('runs synchronously when the editor is already mounted', () => {
    fakeFrames()
    const run = vi.fn()
    whenEditorMounted({ mounted: true }, run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries per frame and runs once the editor mounts', () => {
    const frames = fakeFrames()
    const editor = { mounted: false }
    const run = vi.fn()
    whenEditorMounted(editor, run)
    expect(run).not.toHaveBeenCalled()

    frames.step()
    expect(run).not.toHaveBeenCalled()

    editor.mounted = true
    frames.step()
    expect(run).toHaveBeenCalledTimes(1)
    // Nothing left scheduled once it has run.
    expect(frames.step()).toBe(false)
  })

  it('gives up loudly after the frame budget instead of spinning forever', () => {
    const frames = fakeFrames()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = vi.fn()
    whenEditorMounted({ mounted: false }, run)

    let steps = 0
    while (frames.step()) {
      steps += 1
      expect(steps).toBeLessThan(100) // the budget must terminate the loop
    }

    expect(steps).toBe(30)
    expect(run).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledOnce()
  })

  it('cancel stops the retry loop', () => {
    const frames = fakeFrames()
    const run = vi.fn()
    const cancel = whenEditorMounted({ mounted: false }, run)
    cancel()
    expect(frames.canceled()).toBe(1)
    // Canceling again (or after settling) stays a no-op.
    cancel()
    expect(frames.canceled()).toBe(1)
  })
})
