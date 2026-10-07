import { describe, expect, it } from 'vitest'
import type { BackupState } from '@/lib/backup-controller.ts'
import { mobileSyncStatus } from './sync-status.ts'

/**
 * The plain-language mapping (Plan 19, step 10): engine product states plus
 * the conflicted-note count become the words mobile shows — never git terms.
 */

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    role: 'writer',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

describe('mobileSyncStatus', () => {
  it('has nothing to say without a configured backup', () => {
    expect(mobileSyncStatus({ phase: 'loading' }, 0)).toBeNull()
    expect(mobileSyncStatus({ phase: 'disconnected' }, 0)).toBeNull()
  })

  it('rests on Backed up — the quiet tone the pill hides on', () => {
    const status = mobileSyncStatus(connected({ state: 'idle' }), 0)
    expect(status).toEqual({ label: 'Backed up', tone: 'ok', detail: null })
  })

  it('shows Syncing while a cycle runs — even with conflicts pending', () => {
    const status = mobileSyncStatus(connected({ state: 'syncing' }), 2)
    expect(status?.label).toBe('Syncing')
    expect(status?.tone).toBe('active')
  })

  it('headlines Needs review while any note carries conflict markers', () => {
    const one = mobileSyncStatus(connected({ state: 'idle' }), 1)
    expect(one?.label).toBe('Needs review')
    expect(one?.tone).toBe('attention')
    expect(one?.detail).toMatch(/open it to choose what to keep/i)

    const many = mobileSyncStatus(connected({ state: 'idle' }), 3)
    expect(many?.detail).toMatch(/^3 notes/)
    expect(many?.detail).toMatch(/open them to choose what to keep/i)
  })

  it('conflicts outrank a failed cycle (the actionable state leads)', () => {
    const status = mobileSyncStatus(
      connected({ state: 'error', errorKind: 'other', message: 'boom' }),
      1,
    )
    expect(status?.label).toBe('Needs review')
  })

  it('surfaces errors as Needs attention with the engine message', () => {
    const status = mobileSyncStatus(
      connected({ state: 'error', errorKind: 'auth', message: 'Sign in again' }),
      0,
    )
    expect(status?.label).toBe('Needs attention')
    expect(status?.detail).toBe('Sign in again')
  })

  it('surfaces offline plainly — changes are safe locally', () => {
    const status = mobileSyncStatus(
      connected({ state: 'offline', message: 'Offline — changes are saved locally' }),
      0,
    )
    expect(status?.label).toBe('Offline')
    expect(status?.tone).toBe('attention')
    expect(status?.detail).toMatch(/saved locally/)
  })
})
