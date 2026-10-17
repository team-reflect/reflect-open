import { act } from '@/test-utils/act.ts'
import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { LINGER_MS, MIN_VISIBLE_MS } from '@reflect/app'
import type { OperationHandle } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { MobileOperationsPills } from './operations-pill.tsx'
import { MobileStatusLayer } from './status-layer.tsx'

/**
 * The mobile face of the operations store: failed/warning background work
 * shows as pills above the tab bar (running work stays silent), a tap
 * dismisses, and the layer yields to the keyboard like the sync pill.
 */

// The layer renders the sync pill too. No sync lifecycle is mounted here, so
// it stays quiet and these tests only see operation pills (its own behavior
// is covered in sync-status-pill.test.tsx).

/**
 * Start an operation inside act so the store emit lands in a React batch.
 */
async function operate(run: () => OperationHandle): Promise<OperationHandle> {
  let handle: OperationHandle | undefined
  await act(() => {
    handle = run()
  })
  return handle!
}

describe('MobileOperationsPills', () => {
  it('renders nothing while operations are merely running', async () => {
    const { appServices } = await renderInApp(<MobileOperationsPills />)
    await operate(() => appServices.operations.start('Completing task'))

    expect(page.getByRole('status').query()).toBeNull()
    expect(page.getByRole('alert').query()).toBeNull()
  })

  it('shows a failed operation with its label and message', async () => {
    const { appServices } = await renderInApp(<MobileOperationsPills />)
    const handle = await operate(() => appServices.operations.start('Completing task'))
    await act(() => handle.fail('The note is busy.'))

    const pill = page.getByRole('alert')
    await expect.element(pill).toMatchTextContent('Completing task')
    await expect.element(pill).toMatchTextContent('The note is busy.')
  })

  it('shows a warning as a status pill', async () => {
    const { appServices } = await renderInApp(<MobileOperationsPills />)
    const handle = await operate(() => appServices.operations.start('Importing notes'))
    await act(() => handle.warn('2 files skipped.'))

    await expect.element(page.getByRole('status')).toMatchTextContent('2 files skipped.')
  })

  it('dismisses a pill on tap', async () => {
    const { appServices } = await renderInApp(<MobileOperationsPills />)
    const handle = await operate(() => appServices.operations.start('Completing task'))
    await act(() => handle.fail('The note is busy.'))

    await page.getByRole('alert').click()

    await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
  })

  it('expires with the store’s linger window', async () => {
    const { app, appServices } = await renderInApp(<MobileOperationsPills />)
    const handle = await operate(() => appServices.operations.start('Completing task'))
    await act(() => handle.fail('The note is busy.'))

    await act(() => app.clock.advance(LINGER_MS + MIN_VISIBLE_MS))

    expect(page.getByRole('alert').query()).toBeNull()
  })
})

describe('MobileStatusLayer', () => {
  it('yields to the software keyboard', async () => {
    const { appServices } = await renderInApp(<MobileStatusLayer />)
    const handle = await operate(() => appServices.operations.start('Completing task'))
    await act(() => handle.fail('The note is busy.'))
    await expect.element(page.getByRole('alert')).toBeVisible()

    await act(() => appServices.keyboard.publish(300))

    expect(page.getByRole('alert').query()).toBeNull()
  })
})
