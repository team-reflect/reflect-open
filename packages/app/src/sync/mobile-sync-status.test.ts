import { describe, expect, it } from 'vitest'
import type { BackupState } from '@reflect/core'
import { mobileSyncStatus, type MobileSyncStatus } from './mobile-sync-status.ts'

/**
 * The plain-language mapping (Plan 19, step 10): engine product states
 * become the words mobile shows — never git terms.
 */

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

function statusFor(backup: BackupState): MobileSyncStatus | null {
  return mobileSyncStatus({ backup, now: 0 })
}

describe('engine state', () => {
  it('has nothing to say without a configured backup', () => {
    expect(statusFor({ phase: 'loading' })).toBeNull()
    expect(statusFor({ phase: 'disconnected' })).toBeNull()
  })

  it('rests on Backed up — the quiet tone the pill hides on', () => {
    const status = statusFor(connected({ state: 'idle' }))
    expect(status).toEqual({ label: 'Backed up', tone: 'ok', detail: null })
  })

  it('maps a waiting window to Backed up with the time left', () => {
    expect(statusFor(connected({ state: 'waiting', until: 2 * 60_000 + 1 }))).toEqual({
      label: 'Backed up',
      tone: 'ok',
      detail: 'Backs up in 2 minutes',
    })
    expect(statusFor(connected({ state: 'waiting', until: 30_000 }))?.detail).toBe(
      'Backs up in 30 seconds',
    )
  })

  it('shows Syncing while a cycle runs', () => {
    const status = statusFor(connected({ state: 'syncing' }))
    expect(status?.label).toBe('Syncing')
    expect(status?.tone).toBe('active')
  })

  it('surfaces errors as Needs attention with the engine message', () => {
    const status = statusFor(
      connected({ state: 'error', errorKind: 'auth', message: 'Sign in again' }),
    )
    expect(status?.label).toBe('Needs attention')
    expect(status?.detail).toBe('Sign in again')
  })

  it('surfaces offline plainly — changes are safe locally', () => {
    const status = statusFor(
      connected({ state: 'offline', message: 'Offline — changes are saved locally' }),
    )
    expect(status?.label).toBe('Offline')
    expect(status?.tone).toBe('attention')
    expect(status?.detail).toMatch(/saved locally/)
  })
})

describe('mobileSyncStatus', () => {
  it('has nothing to say without a backup lifecycle', () => {
    expect(mobileSyncStatus({ backup: null, now: 0 })).toBeNull()
  })

  it('reports engine states', () => {
    expect(
      mobileSyncStatus({ backup: connected({ state: 'offline', message: 'Offline' }), now: 0 }),
    ).toEqual({ label: 'Offline', tone: 'attention', detail: 'Offline' })
  })
})
