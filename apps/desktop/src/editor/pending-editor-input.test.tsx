import { MeowdownEditor, type EditorHandle } from '@meowdown/react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isFlushableDomObserver, settledEditorMarkdown } from './pending-editor-input'

/**
 * Rot detection for the pending-input barrier's ProseMirror reach-in.
 *
 * `flushPendingEditorDom` degrades to a no-op when `view.domObserver` stops
 * matching the expected shape — safe at runtime, but it would silently
 * re-open the emoji-title data loss the barrier exists to prevent. Every
 * other test of the barrier mocks the observer, so this one mounts the REAL
 * editor: a meowdown/ProseMirror upgrade that changes the internal shape
 * fails here instead of shipping a disabled barrier.
 */

// jsdom gaps the real editor trips over: meowdown's popup custom elements
// query Web Animations on connect. vitest isolates globals per test file, so
// there is nothing to tear down.
Element.prototype.getAnimations ??= () => []

afterEach(cleanup)

async function mountRealEditor(): Promise<EditorHandle> {
  let handle: EditorHandle | null = null
  render(
    <MeowdownEditor
      // The drag handle is popup chrome jsdom can't construct; the barrier's
      // reach-in targets the core view, which mounts fine without it.
      blockHandle={false}
      handleRef={(next) => {
        handle = next ?? handle
      }}
    />,
  )
  await waitFor(() => {
    expect(handle?.editor).toBeDefined()
  })
  return handle!
}

describe('pending-input barrier against the real editor', () => {
  it('still finds a flushable domObserver on the mounted ProseMirror view', async () => {
    const handle = await mountRealEditor()
    const observer: unknown = Reflect.get(handle.editor!.view, 'domObserver')

    expect(isFlushableDomObserver(observer)).toBe(true)
  })

  it('settles and serializes through the real observer without throwing', async () => {
    const handle = await mountRealEditor()
    handle.setMarkdown('# Business ideas')

    await waitFor(() => {
      expect(settledEditorMarkdown(handle)).toBe('# Business ideas\n')
    })
  })
})
