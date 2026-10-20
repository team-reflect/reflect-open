import { describe, expect, it } from 'vitest'
import type { GitSyncState } from '@reflect/core'
import { getMobileSyncStatus, type MobileSyncStatus } from './mobile-sync-status.ts'

/**
 * The plain-language mapping (Plan 19, step 10): engine product states
 * become the words mobile shows, never git terms.
 */

function connected(status: Extract<GitSyncState, { phase: 'connected' }>['status']): GitSyncState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

function statusFor(gitSync: GitSyncState): MobileSyncStatus | null {
  return getMobileSyncStatus(gitSync)
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

  it('maps a waiting window to Backed up with the time the backup is due', () => {
    expect(statusFor(connected({ state: 'waiting', until: 2 * 60_000 + 1 }))).toEqual({
      label: 'Backed up',
      tone: 'ok',
      detail: { kind: 'countdown', until: 2 * 60_000 + 1 },
    })
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
    expect(status?.detail).toEqual({ kind: 'message', text: 'Sign in again' })
  })

  it('surfaces offline plainly — changes are safe locally', () => {
    const status = statusFor(
      connected({ state: 'offline', message: 'Offline — changes are saved locally' }),
    )
    expect(status?.label).toBe('Offline')
    expect(status?.tone).toBe('attention')
    expect(status?.detail).toEqual({
      kind: 'message',
      text: 'Offline — changes are saved locally',
    })
  })
})

describe('getMobileSyncStatus', () => {
  it('has nothing to say without a backup lifecycle', () => {
    expect(getMobileSyncStatus(null)).toBeNull()
  })

  it('reports engine states', () => {
    expect(getMobileSyncStatus(connected({ state: 'offline', message: 'Offline' }))).toEqual({
      label: 'Offline',
      tone: 'attention',
      detail: { kind: 'message', text: 'Offline' },
    })
  })
})
