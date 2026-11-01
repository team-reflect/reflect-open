import { page, userEvent } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { NoteRevision } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { NoteHistoryAction } from '@/components/context-sidebar/note-history-action.tsx'
import { NoteHistoryProvider } from '@/providers/note-history-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteHistoryDialog } from './note-history-dialog.tsx'

const PATH = 'notes/atlas.md'
const NEWER: NoteRevision = {
  oid: 'b2',
  path: PATH,
  timeMs: Date.UTC(2026, 9, 30, 12),
  summary: 'Update Atlas',
}
const OLDER: NoteRevision = {
  oid: 'a1',
  path: 'notes/01j.md',
  timeMs: Date.UTC(2026, 9, 29, 12),
  summary: 'Add Untitled',
}
const TEXT: Record<string, string> = {
  b2: '---\nid: 01j\n---\n# Atlas\n\nnewer words\n',
  a1: '---\nid: 01j\n---\n# Untitled\n\nolder words\n',
}

async function renderHistory(options?: { available?: boolean; revisions?: NoteRevision[] }) {
  const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
  const isAvailable = vi
    .spyOn(core.noteHistory, 'isAvailable')
    .mockResolvedValue(options?.available ?? true)
  const revisions = vi.spyOn(core.noteHistory, 'revisions').mockResolvedValue({
    revisions: options?.revisions ?? [NEWER, OLDER],
    nextCursor: null,
  })
  vi.spyOn(core.noteHistory, 'revisionText').mockImplementation((revision) => {
    return Promise.resolve(TEXT[revision.oid] ?? '')
  })
  const restore = vi.spyOn(core.noteHistory, 'restore').mockResolvedValue()
  await renderInApp(
    <NoteHistoryProvider>
      <NoteHistoryAction path={PATH} />
      <NoteHistoryDialog />
    </NoteHistoryProvider>,
    { core, route: { kind: 'note', path: PATH } },
  )
  return { restore, isAvailable, revisions }
}

describe('NoteHistoryDialog', () => {
  it('offers note history only for a graph that keeps it', async () => {
    const { isAvailable } = await renderHistory({ available: false })

    await vi.waitFor(() => expect(isAvailable).toHaveBeenCalled())
    await expect.element(page.getByRole('button', { name: 'Note history' })).not.toBeInTheDocument()
  })

  it('lists the revisions and previews the newest, then the one the arrow keys select', async () => {
    await renderHistory()

    await page.getByRole('button', { name: 'Note history' }).click()

    await expect.element(page.getByRole('option', { name: /Update Atlas/ })).toBeVisible()
    await expect.element(page.getByRole('option', { name: /Add Untitled/ })).toBeVisible()
    await expect.element(page.getByText('newer words')).toBeVisible()

    await userEvent.keyboard('{ArrowDown}')

    await expect.element(page.getByText('older words')).toBeVisible()
    await expect
      .element(page.getByRole('option', { name: /Add Untitled/ }))
      .toHaveAttribute('aria-selected', 'true')
  })

  it('restores the selected revision and closes', async () => {
    const { restore } = await renderHistory()
    await page.getByRole('button', { name: 'Note history' }).click()
    await page.getByRole('option', { name: /Add Untitled/ }).click()

    await page.getByRole('button', { name: 'Restore this version' }).click()

    expect(restore).toHaveBeenCalledWith(PATH, OLDER)
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers a retry when an older page fails to load', async () => {
    const { revisions } = await renderHistory()
    revisions
      .mockResolvedValueOnce({ revisions: [NEWER], nextCursor: NEWER.oid })
      .mockRejectedValueOnce(new Error('git failed'))
      .mockResolvedValueOnce({ revisions: [OLDER], nextCursor: null })

    await page.getByRole('button', { name: 'Note history' }).click()
    await page.getByRole('button', { name: /Couldn’t load older versions/ }).click()

    await expect.element(page.getByRole('option', { name: /Add Untitled/ })).toBeVisible()
  })

  it('explains an empty history', async () => {
    await renderHistory({ revisions: [] })

    await page.getByRole('button', { name: 'Note history' }).click()

    await expect.element(page.getByText(/No saved versions yet/)).toBeVisible()
  })
})
