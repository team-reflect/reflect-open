import { describe, expect, it, vi } from 'vitest'
import {
  NORMAL_DIAGNOSTICS_STATUS,
  prepareApplicationStartup,
  resolveDiagnosticsStartup,
} from './diagnostics-bootstrap'

describe('resolveDiagnosticsStartup', () => {
  it('preserves native safe mode for the root gate', async () => {
    const safeMode = {
      safeMode: true,
      reason: 'repeatedWebContentTerminations' as const,
      recentWebContentTerminations: 3,
    }
    await expect(resolveDiagnosticsStartup(true, async () => safeMode)).resolves.toEqual(safeMode)
  })

  it('does not warm storage or the platform tree in safe mode', async () => {
    const warm = vi.fn()
    await prepareApplicationStartup(
      true,
      warm,
      async () => ({
        safeMode: true,
        reason: 'repeatedWebContentTerminations',
        recentWebContentTerminations: 3,
      }),
    )
    expect(warm).not.toHaveBeenCalled()
  })

  it('fails open when the journal cannot be read', async () => {
    await expect(
      resolveDiagnosticsStartup(true, async () => {
        throw new Error('unreadable')
      }),
    ).resolves.toEqual(NORMAL_DIAGNOSTICS_STATUS)
  })

  it('warms normal startup after a journal failure', async () => {
    const warm = vi.fn()
    await prepareApplicationStartup(true, warm, async () => {
      throw new Error('unreadable')
    })
    expect(warm).toHaveBeenCalledOnce()
  })

  it('does not invoke native diagnostics off iOS', async () => {
    const bootstrap = vi.fn()
    await expect(resolveDiagnosticsStartup(false, bootstrap)).resolves.toEqual(
      NORMAL_DIAGNOSTICS_STATUS,
    )
    expect(bootstrap).not.toHaveBeenCalled()
  })
})
