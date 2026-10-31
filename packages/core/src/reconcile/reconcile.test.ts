import { describe, expect, it } from 'vitest'
import { isSilentStop, type ReconcileStop } from './reconcile.ts'

describe('isSilentStop', () => {
  const stop = (reason: ReconcileStop['reason']): ReconcileStop => ({ reason, message: reason })

  it('treats the self-healing reasons as silent', () => {
    expect(isSilentStop(stop('network'))).toBe(true)
    expect(isSilentStop(stop('config'))).toBe(true)
    expect(isSilentStop(stop('stale'))).toBe(true)
  })

  it('treats unexpected reasons as worth surfacing', () => {
    expect(isSilentStop(stop('auth'))).toBe(false)
    expect(isSilentStop(stop('io'))).toBe(false)
    expect(isSilentStop(stop('unknown'))).toBe(false)
  })
})
