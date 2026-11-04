import { describe, expect, it } from 'vitest'
import { createTestLoggerService } from '@reflect/core/testing'
import { createTestUpdateService } from '../testing/update.ts'
import { getUpdateToasts } from './update-toasts.ts'
import type { UpdateState } from './update-service.ts'

function getToasts(state: UpdateState) {
  const update = createTestUpdateService(state)
  return { update, toasts: getUpdateToasts(state, update, createTestLoggerService()) }
}

describe('getUpdateToasts', () => {
  it('shows an install action that stays open while an update is available', () => {
    const { update, toasts } = getToasts({ phase: 'available', version: '1.2.3' })
    expect(toasts).toEqual([
      expect.objectContaining({
        id: 'reflect-update',
        title: 'Update available',
        description: 'Reflect 1.2.3 is ready to install.',
        timeout: 0,
        dismissible: false,
      }),
    ])

    expect(toasts[0]?.action?.label).toBe('Install')
    toasts[0]?.action?.run()
    expect(update.calls).toEqual(['install'])
  })

  it('shows the progress without an action while downloading, then a restart action', () => {
    const downloading = getToasts({ phase: 'downloading', version: '1.2.3', percent: 42 }).toasts
    expect(downloading).toEqual([
      expect.objectContaining({ title: 'Downloading update', description: '42%', type: 'loading' }),
    ])
    expect(downloading[0]?.action).toBeUndefined()

    const ready = getToasts({ phase: 'ready', version: '1.2.3' }).toasts
    expect(ready).toEqual([expect.objectContaining({ title: 'Update ready', type: 'success' })])
    expect(ready[0]?.action?.label).toBe('Restart')
  })

  it('surfaces install errors but ignores check-only failures', () => {
    expect(getToasts({ phase: 'error', message: 'offline', during: 'check' }).toasts).toEqual([])

    const { update, toasts } = getToasts({
      phase: 'error',
      message: 'signature failed',
      during: 'install',
    })
    expect(toasts).toEqual([
      expect.objectContaining({
        title: 'Update failed',
        description: 'signature failed',
        type: 'error',
      }),
    ])
    expect(toasts[0]?.action?.label).toBe('Retry install')
    toasts[0]?.action?.run()
    expect(update.calls).toEqual(['retryAction', 'install'])
  })

  it('shows nothing while idle, checking, or up to date', () => {
    expect(getToasts({ phase: 'idle' }).toasts).toEqual([])
    expect(getToasts({ phase: 'checking' }).toasts).toEqual([])
    expect(getToasts({ phase: 'upToDate' }).toasts).toEqual([])
  })
})
