import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { DEFAULT_SETTINGS, type Settings } from '@reflect/core'
import { FilenameMigrationPrompt } from './filename-migration-prompt'

const migration = vi.hoisted(() => ({
  findMigrationCandidates: vi.fn(),
  runFilenameMigration: vi.fn(),
}))
vi.mock('@/lib/filename-migration', () => migration)

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

const CANDIDATES = [
  { path: 'notes/01arz3ndektsv4rrffq69g5fav.md', title: 'Alpha' },
  { path: 'notes/01brz3ndektsv4rrffq69g5fbw.md', title: 'Beta' },
]

beforeEach(() => {
  migration.findMigrationCandidates.mockReset()
  migration.findMigrationCandidates.mockResolvedValue(CANDIDATES)
  migration.runFilenameMigration.mockReset()
  migration.runFilenameMigration.mockResolvedValue(undefined)
  graphState.indexing = false
  settingsState.settings = { ...DEFAULT_SETTINGS, filenameMigrationDeclined: [] }
  settingsState.patches = []
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

  it('Esc is a defer, not a decline: nothing recorded, re-offered next open', async () => {
    const view = render(<FilenameMigrationPrompt />)
    await view.findByText('Use readable filenames?')

    // Radix closes on Escape; the reflexive startup-Esc must not be sticky.
    act(() => {
      view.getByRole('dialog').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })

    expect(view.queryByText('Use readable filenames?')).toBeNull()
    expect(settingsState.patches).toEqual([]) // no decline written
    expect(migration.runFilenameMigration).not.toHaveBeenCalled()
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

  it('accepting dismisses the dialog and hands the candidates to the runner', async () => {
    const view = render(<FilenameMigrationPrompt />)
    const accept = await view.findByRole('button', { name: 'Rename 2 notes' })
    act(() => accept.click())

    expect(migration.runFilenameMigration).toHaveBeenCalledWith({
      candidates: CANDIDATES,
      generation: 5,
    })
    expect(settingsState.patches).toEqual([]) // accepted ≠ declined
    expect(view.queryByText('Use readable filenames?')).toBeNull()
    view.unmount()
  })
})
