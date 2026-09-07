import { StrictMode, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArrivalFocus } from '@/mobile/use-arrival-focus'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { deferred } from '@/test-utils/deferred'

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

// Stands in for a screen whose content arrives after the route does: the
// focus target only mounts once `ready` resolves, the way a lazily loaded
// feature or a late query result would.
function LateFeature({
  ready,
  ...props
}: FeatureInputProps & { ready: Promise<void> }): ReactElement | null {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    let active = true
    void ready.then(() => {
      if (active) setMounted(true)
    })
    return () => {
      active = false
    }
  }, [ready])
  return mounted ? <FeatureInput {...props} /> : null
}

function ModalFocusHarness({
  children,
  nextDialogOnClose = false,
}: {
  children: ReactNode
  nextDialogOnClose?: boolean
}): ReactElement {
  const [modal, setModal] = useState<'first' | 'second' | null>('first')
  const previousRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={previousRef} autoFocus>
        Previous surface
      </button>
      {children}
      <Dialog
        open={modal === 'first'}
        onOpenChange={(open) => {
          if (!open) setModal(nextDialogOnClose ? 'second' : null)
        }}
      >
        <DialogContent>
          <DialogTitle>Quick capture</DialogTitle>
          <DialogDescription>Add a note.</DialogDescription>
          {/* No `autoFocus`: React would focus this input during the popup's own
              commit, before Base UI records the element to return focus to. */}
          <input aria-label="Dialog input" />
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
          <input aria-label="Newer input" />
        </DialogContent>
      </Dialog>
    </>
  )
}

afterEach(async () => {
  await cleanup()
  vi.restoreAllMocks()
})

describe('requestSurfaceFocus', () => {
  it('waits for a dialog to close before focusing the feature that loaded behind it', async () => {
    const loading = deferred<void>()
    await render(
      <ModalFocusHarness>
        <LateFeature ready={loading.promise} label="Background search" selectText />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve()
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

  it('focuses immediately while the dialog is still animating out, and keeps focus after it unmounts', async () => {
    const loading = deferred<void>()
    await render(
      <ModalFocusHarness>
        <LateFeature ready={loading.promise} label="Background search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    // The test browser runs with reduced motion, which collapses the dialog's
    // CSS exit animation, so a paused WAAPI animation holds the popup in its
    // closing state instead.
    const popup = page.getByRole('dialog').element()
    const exitAnimation = popup.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 })
    exitAnimation.pause()
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(popup.hasAttribute('data-closed')).toBe(true))
    loading.resolve()
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
    expect(popup.isConnected).toBe(true)
    exitAnimation.finish()
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).not.toHaveFocus()
  })

  it('preserves a blocked arrival through StrictMode effect cleanup', async () => {
    const loading = deferred<void>()
    await render(
      <StrictMode>
        <ModalFocusHarness>
          <LateFeature ready={loading.promise} label="Background search" />
        </ModalFocusHarness>
      </StrictMode>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve()
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'Background search' })).toHaveFocus()
  })

  it('cancels pending modal focus when its destination unmounts', async () => {
    const loading = deferred<void>()
    const view = await render(
      <ModalFocusHarness>
        <LateFeature ready={loading.promise} label="Abandoned search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve()
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
    const loading = deferred<void>()
    const view = await render(
      <ModalFocusHarness>
        <LateFeature ready={loading.promise} label="Background search" arrivalSeq={1} />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve()
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await view.rerender(
      <ModalFocusHarness>
        <LateFeature
          ready={loading.promise}
          label="Background search"
          arrivalSeq={2}
          arrivalFocusEditor={false}
        />
      </ModalFocusHarness>,
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).toHaveFocus()
  })

  it('lets a newer modal supersede the pending route focus', async () => {
    const loading = deferred<void>()
    await render(
      <ModalFocusHarness nextDialogOnClose>
        <LateFeature ready={loading.promise} label="Background search" />
      </ModalFocusHarness>,
    )
    await expect.element(page.getByRole('textbox', { name: 'Dialog input' })).toHaveFocus()
    loading.resolve()
    await vi.waitFor(() =>
      expect(document.querySelector('[aria-label="Background search"]')).not.toBeNull(),
    )
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('textbox', { name: 'Newer input' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('button', { name: 'Previous surface' })).toHaveFocus()
  })
})
