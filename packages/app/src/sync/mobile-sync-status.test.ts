import { describe, expect, it } from 'vitest'
import type { BackupState } from '@reflect/core'
import { mobileSyncStatus, type MobileSyncStatus } from './mobile-sync-status.ts'

/**
 * The plain-language mapping (Plan 19, step 10): engine product states plus
 * the conflicted-note count become the words mobile shows — never git terms.
 */

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

function statusFor(backup: BackupState, conflictCount: number): MobileSyncStatus | null {
  return mobileSyncStatus({ backup, conflictCount, conflictCountUnavailable: false, now: 0 })
}

describe('engine state and conflict count', () => {
  it('has nothing to say without a configured backup', () => {
    expect(statusFor({ phase: 'loading' }, 0)).toBeNull()
    expect(statusFor({ phase: 'disconnected' }, 0)).toBeNull()
  })

  it('rests on Backed up — the quiet tone the pill hides on', () => {
    const status = statusFor(connected({ state: 'idle' }), 0)
    expect(status).toEqual({ label: 'Backed up', tone: 'ok', detail: null })
  })

  it('maps a waiting window to Backed up with the minutes left', () => {
    expect(statusFor(connected({ state: 'waiting', until: 2 * 60_000 + 1 }), 0)).toEqual({
      label: 'Backed up',
      tone: 'ok',
      detail: 'Backs up in 3 min',
    })
    expect(statusFor(connected({ state: 'waiting', until: 5 }), 0)?.detail).toBe(
      'Backs up in 1 min',
    )
  })

  it('shows Syncing while a cycle runs — even with conflicts pending', () => {
    const status = statusFor(connected({ state: 'syncing' }), 2)
    expect(status?.label).toBe('Syncing')
    expect(status?.tone).toBe('active')
  })

  it('headlines Needs review while any note carries conflict markers', () => {
    const one = statusFor(connected({ state: 'idle' }), 1)
    expect(one?.label).toBe('Needs review')
    expect(one?.tone).toBe('attention')
    expect(one?.detail).toMatch(/open it to choose what to keep/i)

    const many = statusFor(connected({ state: 'idle' }), 3)
    expect(many?.detail).toMatch(/^3 notes/)
    expect(many?.detail).toMatch(/open them to choose what to keep/i)
  })

  it('conflicts outrank a failed cycle (the actionable state leads)', () => {
    const status = statusFor(connected({ state: 'error', errorKind: 'other', message: 'boom' }), 1)
    expect(status?.label).toBe('Needs review')
  })

  it('surfaces errors as Needs attention with the engine message', () => {
    const status = statusFor(
      connected({ state: 'error', errorKind: 'auth', message: 'Sign in again' }),
      0,
    )
    expect(status?.label).toBe('Needs attention')
    expect(status?.detail).toBe('Sign in again')
  })

  it('surfaces offline plainly — changes are safe locally', () => {
    const status = statusFor(
      connected({ state: 'offline', message: 'Offline — changes are saved locally' }),
      0,
    )
    expect(status?.label).toBe('Offline')
    expect(status?.tone).toBe('attention')
    expect(status?.detail).toMatch(/saved locally/)
  })
})

describe('mobileSyncStatus', () => {
  it('has nothing to say without a backup lifecycle', () => {
    expect(
      mobileSyncStatus({ backup: null, conflictCount: 0, conflictCountUnavailable: false, now: 0 }),
    ).toBeNull()
  })

  it('claims nothing until the conflict count is known', () => {
    expect(
      mobileSyncStatus({
        backup: connected({ state: 'offline', message: 'Offline' }),
        conflictCount: undefined,
        conflictCountUnavailable: false,
        now: 0,
      }),
    ).toBeNull()
  })

  it('still reports engine states when the conflict count failed to load', () => {
    expect(
      mobileSyncStatus({
        backup: connected({ state: 'offline', message: 'Offline' }),
        conflictCount: undefined,
        conflictCountUnavailable: true,
        now: 0,
      }),
    ).toEqual({ label: 'Offline', tone: 'attention', detail: 'Offline' })
  })

  it('joins the backup state with the conflict count', () => {
    expect(
      mobileSyncStatus({
        backup: connected({ state: 'idle' }),
        conflictCount: 2,
        conflictCountUnavailable: false,
        now: 0,
      })?.label,
    ).toBe('Needs review')
    expect(
      mobileSyncStatus({
        backup: { phase: 'disconnected' },
        conflictCount: undefined,
        conflictCountUnavailable: false,
        now: 0,
      }),
    ).toBeNull()
  })
})
