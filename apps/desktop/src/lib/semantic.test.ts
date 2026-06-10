import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  consumeLegacySemanticOptIn,
  ensureEmbeddingsVisibly,
  retryFailedEmbeddings,
} from './semantic'

const startOperation = vi.hoisted(() => vi.fn())
vi.mock('@/lib/operations', () => ({ startOperation }))

afterEach(() => {
  setBridge(null)
  startOperation.mockReset()
})

function operationHandle() {
  const handle = { progress: vi.fn(), done: vi.fn(), fail: vi.fn() }
  startOperation.mockReturnValue(handle)
  return handle
}

describe('consumeLegacySemanticOptIn', () => {
  it('returns a stored opt-in exactly once (the settings document owns it after)', () => {
    localStorage.setItem('reflect.semantic.enabled', 'true')
    expect(consumeLegacySemanticOptIn()).toBe(true)
    expect(consumeLegacySemanticOptIn()).toBe(false)
    expect(localStorage.getItem('reflect.semantic.enabled')).toBeNull()
  })

  it('is false when the legacy key was never set', () => {
    expect(consumeLegacySemanticOptIn()).toBe(false)
  })
})

describe('retryFailedEmbeddings', () => {
  function bridgeWithStatus(status: unknown): string[] {
    const invoked: string[] = []
    setBridge({
      invoke: async (command) => {
        invoked.push(command)
        return status
      },
      listen: async () => () => {},
    })
    return invoked
  }

  it('re-kicks a failed load', async () => {
    operationHandle()
    const invoked = bridgeWithStatus({ status: 'failed', message: 'offline' })
    await retryFailedEmbeddings()
    expect(invoked).toContain('embed_ensure')
  })

  it('is a no-op for any other status', async () => {
    const invoked = bridgeWithStatus({ status: 'ready', model: 'all-MiniLM-L6-v2' })
    await retryFailedEmbeddings()
    expect(invoked).toEqual(['embed_status'])
  })
})

describe('ensureEmbeddingsVisibly', () => {
  it('resolves the operation only at a terminal status (a racing ensure returns loading)', async () => {
    const handle = operationHandle()
    // Boxed: TS control-flow analysis doesn't track closure assignments and
    // would narrow a plain `let` to `never` at the call site below.
    const emitter: { fire: ((payload: unknown) => void) | null } = { fire: null }
    setBridge({
      invoke: async (command) => {
        if (command === 'embed_ensure') {
          return { status: 'loading' } // someone else is mid-download
        }
        if (command === 'embed_status') {
          return { status: 'loading' }
        }
        return null
      },
      listen: async (_event, handler) => {
        emitter.fire = handler
        return () => {
          emitter.fire = null
        }
      },
    })

    const pending = ensureEmbeddingsVisibly()
    await vi.waitFor(() => expect(emitter.fire).not.toBeNull())
    expect(handle.done).not.toHaveBeenCalled() // still loading — not "done"

    emitter.fire?.({ status: 'ready', model: 'all-MiniLM-L6-v2' })
    const status = await pending
    expect(status).toEqual({ status: 'ready', model: 'all-MiniLM-L6-v2' })
    expect(handle.done).toHaveBeenCalledTimes(1)
  })

  it('a failed load fails the operation with the message', async () => {
    const handle = operationHandle()
    setBridge({
      invoke: async (command) =>
        command === 'embed_ensure' ? { status: 'failed', message: 'no disk space' } : null,
      listen: async () => () => {},
    })
    const status = await ensureEmbeddingsVisibly()
    expect(status.status).toBe('failed')
    expect(handle.fail).toHaveBeenCalledWith('no disk space')
  })
})
