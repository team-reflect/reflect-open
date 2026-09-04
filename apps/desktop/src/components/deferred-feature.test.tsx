import { StrictMode, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus } from '@/mobile/use-arrival-focus'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { createDeferredFeature } from './deferred-feature'

interface FeatureInputProps {
  label: string
  arrivalSeq?: number
  arrivalFocusEditor?: boolean
  selectText?: boolean
}

function FeatureInput({
  label,
  arrivalSeq = 0,
  arrivalFocusEditor = true,
  selectText = false,
}: FeatureInputProps): ReactElement {
  const target = useRef<HTMLInputElement>(null)
  useArrivalFocus({ arrivalSeq, arrivalFocusEditor, target, selectText })
  return <input ref={target} aria-label={label} defaultValue="Existing query" />
}

function ModalFocusHarness({
  children,
  nextDialogOnClose = false,
  onRestoreFocus,
}: {
  children: ReactNode
  nextDialogOnClose?: boolean
  onRestoreFocus?: () => void
}): ReactElement {
  const [modal, setModal] = useState<'first' | 'second' | null>('first')
  const previousRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={previousRef}
        autoFocus
        onFocus={() => {
          if (modal === null) onRestoreFocus?.()
        }}
      >
        Previous surface
      </button>
      {children}
      <Dialog
        open={modal === 'first'}
        onOpenChange={(open) => {
          if (!open) setModal(nextDialogOnClose ? 'second' : null)
        }}
      >
        <DialogContent {...(nextDialogOnClose ? {} : { finalFocus: previousRef })}>
          <DialogTitle>Quick capture</DialogTitle>
          <DialogDescription>Add a note.</DialogDescription>
          <input aria-label="Dialog input" autoFocus />
        </DialogContent>
      </Dialog>
      <Dialog
        open={modal === 'second'}
        onOpenChange={(open) => {
          if (!open) setModal(null)
        }}
      >
        <DialogContent finalFocus={previousRef}>
          <DialogTitle>Newer dialog</DialogTitle>
          <DialogDescription>A newer action.</DialogDescription>
          <input aria-label="Newer input" autoFocus />
        </DialogContent>
      </Dialog>
    </>
  )
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

  it('waits for a dialog to close before focusing the feature that loaded behind it', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <ModalFocusHarness>
        <Feature label="Background search" selectText />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
    const target = document.querySelector<HTMLInputElement>('[aria-label="Background search"]')
    expect(target?.selectionStart).toBe(0)
    expect(target?.selectionEnd).toBe('Existing query'.length)
  })

  it('also waits when the feature loads during the dialog exit animation', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <ModalFocusHarness>
        <Feature label="Background search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    const popup = page.getByRole('dialog').element()
    const exitAnimation = popup.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 })
    exitAnimation.pause()
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(popup.hasAttribute('data-closed')).toBe(true))
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() => {
      const target = document.querySelector('[aria-label="Background search"]')
      expect(target).not.toBeNull()
      expect(target?.closest('[inert], [data-base-ui-inert], [aria-hidden="true"]')).toBeNull()
    })
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).not.toHaveFocus()
    exitAnimation.finish()
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
  })

  it('preserves a blocked arrival through StrictMode effect cleanup', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <StrictMode>
        <ModalFocusHarness>
          <Feature label="Background search" />
        </ModalFocusHarness>
      </StrictMode>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
  })

  it('cancels pending modal focus when its destination unmounts', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    const view = await render(
      <ModalFocusHarness>
        <Feature label="Abandoned search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Abandoned search"]')).not.toBeNull(),
    )
    await view.rerender(
      <ModalFocusHarness>
        <input aria-label="New route" />
      </ModalFocusHarness>,
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).toHaveFocus()
    await expect
      .element(page.getByRole('textbox', { name: 'Abandoned search' }))
      .not.toBeInTheDocument()
  })

  it('cancels a pending focus arrival when a newer arrival does not request focus', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    const view = await render(
      <ModalFocusHarness>
        <Feature label="Background search" arrivalSeq={1} />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await view.rerender(
      <ModalFocusHarness>
        <Feature label="Background search" arrivalSeq={2} arrivalFocusEditor={false} />
      </ModalFocusHarness>,
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).toHaveFocus()
  })

  it('lets a newer modal supersede the pending route focus', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <ModalFocusHarness nextDialogOnClose>
        <Feature label="Background search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'Newer input' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).toHaveFocus()
  })

  it('respects newer focus chosen after the modal restores its previous target', async () => {
    const loading = Promise.withResolvers<{ default: typeof FeatureInput }>()
    const Feature = createDeferredFeature(() => loading.promise, { name: 'search' })
    await render(
      <ModalFocusHarness
        onRestoreFocus={() =>
          document.querySelector<HTMLInputElement>('[aria-label="New action"]')?.focus()
        }
      >
        <Feature label="Background search" />
        <input aria-label="New action" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve({ default: FeatureInput })
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'New action' })).toHaveFocus()
  })
})
