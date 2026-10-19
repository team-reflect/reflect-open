import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { BackupState } from '@reflect/core'
import { createTestCoreServices, createTestBackupService } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SyncStatusPill } from './sync-status-pill.tsx'

/**
 * The floating status pill (Plan 19, step 10): visible only when sync has
 * something to say, plain language only.
 */

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

async function mount(backup: BackupState = connected({ state: 'idle' })): Promise<void> {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    backup: createTestBackupService({ state: backup }),
  })
  await renderInApp(<SyncStatusPill />, { app, graph: { root: '/g', name: 'G', generation: 3 } })
}

describe('SyncStatusPill', () => {
  it('hides in the quiet Backed up state', async () => {
    await mount()

    await Promise.resolve()
    await expect.element(page.getByRole('status')).not.toBeInTheDocument()
  })

  it('shows Syncing while a cycle runs', async () => {
    await mount(connected({ state: 'syncing' }))

    await expect.element(page.getByRole('status')).toMatchTextContent('Syncing')
  })
})
