import { afterEach, describe, expect, it, vi } from 'vitest'
import { printNote } from './print-note.ts'
import { noop } from '@ocavue/utils'

/*
 * Covers which block `printNote` marks for the print styles, and that it only
 * opens the print dialog when the note is on screen.
 */

function addBlock(path: string): HTMLElement {
  const block = document.createElement('section')
  block.dataset.printPath = path
  document.body.append(block)
  return block
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('printNote', () => {
  it('marks only the block of the given note, then prints', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(noop)
    const yesterday = addBlock('daily/2026-11-21.md')
    const today = addBlock('daily/2026-11-22.md')
    yesterday.setAttribute('data-print-target', '')

    printNote('daily/2026-11-22.md')

    expect(today.hasAttribute('data-print-target')).toBe(true)
    expect(yesterday.hasAttribute('data-print-target')).toBe(false)
    expect(print).toHaveBeenCalledOnce()
  })

  it('does nothing when the note is not on screen', () => {
    const print = vi.spyOn(window, 'print').mockImplementation(noop)
    addBlock('notes/other.md')

    printNote('notes/"quoted".md')

    expect(document.querySelector('[data-print-target]')).toBeNull()
    expect(print).not.toHaveBeenCalled()
  })
})
