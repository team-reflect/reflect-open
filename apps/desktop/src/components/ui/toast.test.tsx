import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from './toast'

/**
 * The stacking transforms are arbitrary-value classes, so neither typecheck
 * nor lint can catch a wrong sign in them. These render the real component and
 * measure where the toasts land, after the entrance transition settles.
 */

const SAMPLE_COUNT = 3

function addSampleToasts(): void {
  toast.add({ title: 'One', description: 'plain toast' })
  toast.add({ title: 'Two', type: 'error', description: 'error toast' })
  toast.add({
    title: 'Three',
    description: 'persistent, non-dismissible',
    timeout: 0,
    data: { dismissible: false },
    actionProps: { children: 'Install', onClick: () => {} },
  })
}

function toastElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="toast"]')]
}

/** Asserts the values are strictly increasing, without index gymnastics. */
function expectAscending(values: number[]): void {
  expect(values).toEqual([...values].sort((left, right) => left - right))
  expect(new Set(values).size).toBe(values.length)
}

function viewport(): HTMLElement {
  const element = document.querySelector('[data-slot="toast-viewport"]')
  if (!(element instanceof HTMLElement)) {
    throw new TypeError('no toast viewport')
  }
  return element
}

describe('Toaster', () => {
  it('anchors top-center below the safe-area inset and stacks downward', async () => {
    await render(<Toaster position="top-center" />)
    addSampleToasts()

    // `env(safe-area-inset-top)` is 0 outside iOS, so `max()` falls back to
    // 1rem; on a camera-pill iPhone the inset wins and clears the pill.
    expect(getComputedStyle(viewport()).top).toBe('16px')
    expect(getComputedStyle(viewport()).position).toBe('fixed')

    await vi.waitFor(() => {
      const tops = toastElements().map((element) => Math.round(element.getBoundingClientRect().top))
      expect(tops).toHaveLength(SAMPLE_COUNT)
      // Frontmost sits at the anchor; the ones behind peek further down.
      expect(tops.at(0)).toBe(16)
      expectAscending(tops)
    })
  })

  it('anchors bottom-right above the bottom edge and stacks upward', async () => {
    await render(<Toaster position="bottom-right" />)
    addSampleToasts()

    expect(getComputedStyle(viewport()).bottom).toBe('16px')

    await vi.waitFor(() => {
      const bottoms = toastElements().map((element) =>
        Math.round(element.getBoundingClientRect().bottom),
      )
      expect(bottoms).toHaveLength(SAMPLE_COUNT)
      expect(bottoms.at(0)).toBe(window.innerHeight - 16)
      expectAscending([...bottoms].reverse())
    })
  })

  it('drops the close button on non-dismissible toasts', async () => {
    await render(<Toaster />)
    addSampleToasts()

    await vi.waitFor(() => {
      expect(toastElements()).toHaveLength(SAMPLE_COUNT)
    })
    // Only the two dismissible toasts get a close button; only the one with
    // `actionProps` gets an action, and only the typed one gets an icon.
    expect(document.querySelectorAll('[data-slot="toast-close"]')).toHaveLength(2)
    expect(document.querySelectorAll('[data-slot="toast-action"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-slot="toast-icon"]')).toHaveLength(1)
  })
})
