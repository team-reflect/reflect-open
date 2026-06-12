import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@reflect/core'
import { FilenameMigrationPrompt } from './filename-migration-prompt'

const migration = vi.hoisted(() => ({
  findMigrationCandidates: vi.fn(),
  migrateUlidNotes: vi.fn(),
}))
vi.mock('@/lib/filename-migration', () => migration)

const git = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitCommitAll: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  gitStatus: git.gitStatus,
  gitCommitAll: git.gitCommitAll,
}))

const graphState = vi.hoisted(() => ({ indexing: false }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/graphs/work', name: 'work', cloudSync: null, generation: 5 },
    indexing: graphState.indexing,
  }),
}))

const settingsState = vi.hoisted(() => ({
  settings: null as unknown as Settings,
  patches: [] as Array<Partial<Settings>>,
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: settingsState.settings,
    updateSettings: (patch: Partial<Settings>) => settingsState.patches.push(patch),
    updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) =>
      settingsState.patches.push(updater(settingsState.settings)),
  }),
}))

const operations = vi.hoisted(() => ({
  log: [] as Array<{ label: string; outcome: string; message: string | null }>,
}))
vi.mock('@/lib/operations', () => ({
  startOperation: (label: string) => {
    const record = { label, outcome: 'running', message: null as string | null }
    operations.log.push(record)
    return {
      progress: () => {},
      done: () => {
        record.outcome = 'done'
      },
      fail: (message: string) => {
        record.outcome = 'failed'
        record.message = message
      },
    }
  },
}))

const CANDIDATES = [
  { path: 'notes/01arz3ndektsv4rrffq69g5fav.md', title: 'Alpha' },
  { path: 'notes/01brz3ndektsv4rrffq69g5fbw.md', title: 'Beta' },
]

beforeEach(() => {
  migration.findMigrationCandidates.mockReset()
  migration.findMigrationCandidates.mockResolvedValue(CANDIDATES)
  migration.migrateUlidNotes.mockReset()
  migration.migrateUlidNotes.mockResolvedValue({ moved: 2, skipped: 0, failed: [] })
  git.gitStatus.mockReset()
  git.gitStatus.mockResolvedValue({ initialized: false })
  git.gitCommitAll.mockReset()
  graphState.indexing = false
  settingsState.settings = { ...DEFAULT_SETTINGS, filenameMigrationDeclined: [] }
  settingsState.patches = []
  operations.log = []
})

describe('FilenameMigrationPrompt', () => {
  it('offers the rename once the scan finds ULID-named notes', async () => {
    const view = render(<FilenameMigrationPrompt />)
    await view.findByText('Use readable filenames?')
    expect(view.getByRole('button', { name: 'Rename 2 notes' })).toBeDefined()
    view.unmount()
  })

  it('never scans while the reconcile is still indexing', () => {
    graphState.indexing = true
    const view = render(<FilenameMigrationPrompt />)
    expect(migration.findMigrationCandidates).not.toHaveBeenCalled()
    expect(view.queryByText('Use readable filenames?')).toBeNull()
    view.unmount()
  })

  it('stays silent for a graph the user already declined', () => {
    settingsState.settings = {
      ...settingsState.settings,
      filenameMigrationDeclined: ['/graphs/work'],
    }
    const view = render(<FilenameMigrationPrompt />)
    expect(migration.findMigrationCandidates).not.toHaveBeenCalled()
    view.unmount()
  })

  it('declining records the graph root, sticky', async () => {
    const view = render(<FilenameMigrationPrompt />)
    const decline = await view.findByRole('button', { name: 'Keep current names' })
    act(() => decline.click())

    expect(settingsState.patches).toEqual([{ filenameMigrationDeclined: ['/graphs/work'] }])
    expect(view.queryByText('Use readable filenames?')).toBeNull()
    view.unmount()
  })

  it('accepting checkpoints an initialized repo, runs the migration, reports done', async () => {
    git.gitStatus.mockResolvedValue({ initialized: true })
    git.gitCommitAll.mockResolvedValue({ committed: true, sha: 'abc', ahead: 1 })
    const view = render(<FilenameMigrationPrompt />)
    const accept = await view.findByRole('button', { name: 'Rename 2 notes' })
    act(() => accept.click())

    await waitFor(() => expect(operations.log[0]?.outcome).toBe('done'))
    expect(git.gitCommitAll).toHaveBeenCalledWith('Checkpoint before readable filenames', 5)
    expect(migration.migrateUlidNotes).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: CANDIDATES, generation: 5 }),
    )
    expect(settingsState.patches).toEqual([]) // accepted ≠ declined
    view.unmount()
  })

  it('skips the checkpoint when no repo exists, and a failed checkpoint aborts', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const view = render(<FilenameMigrationPrompt />)
      act(() => {})
      const accept = await view.findByRole('button', { name: 'Rename 2 notes' })
      act(() => accept.click())
      await waitFor(() => expect(operations.log[0]?.outcome).toBe('done'))
      expect(git.gitCommitAll).not.toHaveBeenCalled() // uninitialized: no checkpoint
      view.unmount()

      // Second mount: a repo exists but the checkpoint commit fails — abort.
      git.gitStatus.mockResolvedValue({ initialized: true })
      git.gitCommitAll.mockRejectedValue(new Error('index locked'))
      migration.migrateUlidNotes.mockClear()
      operations.log = []
      const second = render(<FilenameMigrationPrompt />)
      const retry = await second.findByRole('button', { name: 'Rename 2 notes' })
      act(() => retry.click())
      await waitFor(() => expect(operations.log[0]?.outcome).toBe('failed'))
      expect(migration.migrateUlidNotes).not.toHaveBeenCalled()
      expect(operations.log[0]?.message).toContain('nothing was renamed')
      second.unmount()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
