import { afterEach, describe, expect, it, vi } from 'vitest'
import { whenEditorMounted } from './when-editor-mounted'

/**
 * Frame scheduling is driven by hand: `requestAnimationFrame` pushes into a
 * queue the test drains one frame at a time, so the retry budget is exact
 * rather than timing-dependent.
 */
interface FakeFrames {
  /** Run the oldest queued frame; `false` when nothing is scheduled. */
  step: () => boolean
  canceled: () => number
}

function fakeFrames(): FakeFrames {
  const queue = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  let canceled = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const handle = nextHandle
    nextHandle += 1
    queue.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    if (queue.delete(handle)) {
      canceled += 1
    }
  })
  return {
    step: () => {
      const next = queue.entries().next()
      if (next.done === true) {
        return false
      }
      const [handle, frame] = next.value
      queue.delete(handle)
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
    // The canceled frame is genuinely gone — nothing left to run.
    expect(frames.step()).toBe(false)
    expect(run).not.toHaveBeenCalled()
    // Canceling again (or after settling) stays a no-op.
    cancel()
    expect(frames.canceled()).toBe(1)
  })
})
