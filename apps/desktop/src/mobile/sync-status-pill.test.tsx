import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { createTestAppServices } from '@reflect/app/testing'
import type { BackupState } from '@reflect/core'
import { createTestCoreServices, createTestBackupService } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { SyncStatusPill } from './sync-status-pill.tsx'

/**
 * The floating status pill (Plan 19, step 10): visible only when sync has
 * something to say, plain language only, and it yields to the keyboard.
 */

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

interface MountOptions {
  backup?: BackupState
  /**
   * The height of the software keyboard.
   */
  keyboardInset?: number
}

async function mount(options?: MountOptions): Promise<void> {
  const app = createTestCoreServices({
    backup: createTestBackupService({
      state: options?.backup ?? connected({ state: 'idle' }),
    }),
  })
  const appServices = createTestAppServices(app)
  if (options?.keyboardInset !== undefined) {
    appServices.keyboard.publish(options.keyboardInset)
  }
  await renderInApp(<SyncStatusPill />, {
    app,
    appServices,
    graph: { root: '/g', name: 'G', generation: 3 },
  })
}

describe('SyncStatusPill', () => {
  it('hides in the quiet Backed up state', async () => {
    await mount()

    await Promise.resolve()
    await expect.element(page.getByRole('status')).not.toBeInTheDocument()
  })

  it('shows Syncing while a cycle runs', async () => {
    await mount({ backup: connected({ state: 'syncing' }) })

    await expect.element(page.getByRole('status')).toMatchTextContent('Syncing')
  })

  it('yields to the software keyboard', async () => {
    await mount({ backup: connected({ state: 'syncing' }), keyboardInset: 300 })

    await Promise.resolve()
    await expect.element(page.getByRole('status')).not.toBeInTheDocument()
  })
})
