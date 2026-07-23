import { act } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetOperations, startOperation, type OperationHandle } from '@/lib/operations'
import { publishKeyboardHeight } from '@/mobile/use-keyboard'
import { MobileOperationsPills } from './operations-pill'
import { MobileStatusLayer } from './status-layer'

/**
 * The mobile face of the operations store: failed/warning background work
 * shows as pills above the tab bar (running work stays silent), a tap
 * dismisses, and the layer yields to the keyboard like the sync pill.
 */

// The layer renders the sync pill too; keep it quiet so these tests only see
// operation pills (its own behavior is covered in sync-status-pill.test.tsx).
vi.mock('@/mobile/use-sync-status', () => ({ useMobileSyncStatus: () => null }))

beforeEach(() => {
  vi.useFakeTimers()
  resetOperations()
})

afterEach(async () => {
  await cleanup()
  publishKeyboardHeight(0)
  vi.useRealTimers()
})

/** Start an operation inside act so the store emit lands in a React batch. */
function operate(run: () => OperationHandle): OperationHandle {
  let handle: OperationHandle | undefined
  act(() => {
    handle = run()
  })
  return handle!
}

describe('MobileOperationsPills', () => {
  it('renders nothing while operations are merely running', async () => {
    await render(<MobileOperationsPills />)
    operate(() => startOperation('Completing task'))

    expect(page.getByRole('status').query()).toBeNull()
    expect(page.getByRole('alert').query()).toBeNull()
  })

  it('shows a failed operation with its label and message', async () => {
    await render(<MobileOperationsPills />)
    const handle = operate(() => startOperation('Completing task'))
    act(() => handle.fail('The note is busy.'))

    const pill = page.getByRole('alert')
    await expect.element(pill).toHaveTextContent('Completing task')
    await expect.element(pill).toHaveTextContent('The note is busy.')
  })

  it('shows a warning as a status pill', async () => {
    await render(<MobileOperationsPills />)
    const handle = operate(() => startOperation('Importing notes'))
    act(() => handle.warn('2 files skipped.'))

    await expect.element(page.getByRole('status')).toHaveTextContent('2 files skipped.')
  })

  it('dismisses a pill on tap', async () => {
    await render(<MobileOperationsPills />)
    const handle = operate(() => startOperation('Completing task'))
    act(() => handle.fail('The note is busy.'))

    await page.getByRole('alert').click()

    await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
  })

  it('expires with the store’s linger window', async () => {
    await render(<MobileOperationsPills />)
    const handle = operate(() => startOperation('Completing task'))
    act(() => handle.fail('The note is busy.'))

    act(() => vi.runAllTimers())

    expect(page.getByRole('alert').query()).toBeNull()
  })
})

describe('MobileStatusLayer', () => {
  it('yields to the software keyboard', async () => {
    await render(<MobileStatusLayer />)
    const handle = operate(() => startOperation('Completing task'))
    act(() => handle.fail('The note is busy.'))
    await expect.element(page.getByRole('alert')).toBeVisible()

    act(() => publishKeyboardHeight(300))

    expect(page.getByRole('alert').query()).toBeNull()
  })
})
