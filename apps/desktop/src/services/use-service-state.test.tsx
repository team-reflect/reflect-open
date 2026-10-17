import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { act } from '@/test-utils/act.ts'
import { useServiceState } from './use-service-state.ts'

/**
 * A hand-written store that counts its subscriptions.
 */
function createCountingStore(initial: number) {
  let state = initial
  let subscribeCalls = 0
  const listeners = new Set<() => void>()
  return {
    getState: (): number => state,
    subscribe: (listener: () => void): (() => void) => {
      subscribeCalls += 1
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setState: (next: number): void => {
      state = next
      for (const listener of listeners) {
        listener()
      }
    },
    subscribeCalls: (): number => subscribeCalls,
  }
}

type CountingStore = ReturnType<typeof createCountingStore>

function Counter({ store, label }: { store: CountingStore; label: string }) {
  const count = useServiceState(store, store.getState)
  return (
    <p>
      {label} {count}
    </p>
  )
}

describe('useServiceState', () => {
  it('re-renders on a change the service reports', async () => {
    const store = createCountingStore(1)
    const screen = await render(<Counter store={store} label="count" />)
    await expect.element(screen.getByText('count 1')).toBeVisible()

    await act(() => {
      store.setState(2)
    })

    await expect.element(screen.getByText('count 2')).toBeVisible()
  })

  it('does not re-subscribe when the same service renders again', async () => {
    const store = createCountingStore(1)
    const screen = await render(<Counter store={store} label="first" />)
    await expect.element(screen.getByText('first 1')).toBeVisible()
    const subscribed = store.subscribeCalls()

    await screen.rerender(<Counter store={store} label="second" />)

    await expect.element(screen.getByText('second 1')).toBeVisible()
    expect(store.subscribeCalls()).toBe(subscribed)
  })
})
