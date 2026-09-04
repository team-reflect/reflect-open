import { useRef, type ReactElement } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus } from '@/mobile/use-arrival-focus'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { createDeferredFeature } from './deferred-feature'

interface FeatureInputProps {
  label: string
  arrivalSeq?: number
  arrivalFocusEditor?: boolean
}

function FeatureInput({
  label,
  arrivalSeq = 0,
  arrivalFocusEditor = true,
}: FeatureInputProps): ReactElement {
  const target = useRef<HTMLInputElement>(null)
  useArrivalFocus({ arrivalSeq, arrivalFocusEditor, target })
  return <input ref={target} aria-label={label} />
}

afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
})

describe('deferred features', () => {
  it('loads on first render, uses the latest arrival, and reuses the load when revisited', async () => {
    let finishLoad: ((module: { default: typeof FeatureInput }) => void) | undefined
    const pending = new Promise<{ default: typeof FeatureInput }>((resolve) => {
      finishLoad = resolve
    })
    const load = vi.fn(() => pending)
    const Feature = createDeferredFeature(load, { name: 'search' })
    expect(load).not.toHaveBeenCalled()

    const view = await render(
      <Feature label="Initial search" arrivalSeq={1} arrivalFocusEditor={false} />,
    )
    await expect.element(page.getByRole('status')).toHaveTextContent('Loading…')
    expect(load).toHaveBeenCalledTimes(1)

    await view.rerender(<Feature label="Search" arrivalSeq={2} arrivalFocusEditor />)
    finishLoad?.({ default: FeatureInput })
    await expect.element(page.getByRole('textbox', { name: 'Search' })).toHaveFocus()
    await expect.element(page.getByRole('status')).not.toBeInTheDocument()

    await view.unmount()
    await render(<Feature label="Search again" />)
    await expect.element(page.getByRole('textbox', { name: 'Search again' })).toHaveFocus()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('retries a failed import and keeps the recovered load for later visits', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('Chunk temporarily unavailable')
    const load = vi
      .fn<() => Promise<{ default: typeof FeatureInput }>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ default: FeatureInput })
    const Feature = createDeferredFeature(load, { name: 'search' })
    const view = await render(<Feature label="Recovered search" />)

    await expect.element(page.getByRole('alert')).toHaveTextContent('Couldn’t load search.')
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Recovered search' })).toHaveFocus()
    expect(load).toHaveBeenCalledTimes(2)
    expect(consoleError).toHaveBeenCalled()

    await view.unmount()
    await render(<Feature label="Search revisited" />)
    await expect.element(page.getByRole('textbox', { name: 'Search revisited' })).toHaveFocus()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not mount or steal focus when navigation leaves before the load finishes', async () => {
    let finishLoad: ((module: { default: typeof FeatureInput }) => void) | undefined
    const pending = new Promise<{ default: typeof FeatureInput }>((resolve) => {
      finishLoad = resolve
    })
    const Feature = createDeferredFeature(() => pending, { name: 'search' })
    const view = await render(<Feature label="Abandoned search" />)
    await expect.element(page.getByRole('status')).toBeVisible()
    await view.rerender(<input aria-label="Daily note" autoFocus />)
    finishLoad?.({ default: FeatureInput })

    await expect.element(page.getByRole('textbox', { name: 'Daily note' })).toHaveFocus()
    await expect
      .element(page.getByRole('textbox', { name: 'Abandoned search' }))
      .not.toBeInTheDocument()
  })

  it('does not steal focus from a dialog opened while the feature loads', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <>
        <Feature label="Background search" />
        <Dialog open>
          <DialogContent>
            <DialogTitle>Quick capture</DialogTitle>
            <DialogDescription>Add a note.</DialogDescription>
            <input aria-label="Dialog input" autoFocus />
          </DialogContent>
        </Dialog>
      </>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
  })
})
