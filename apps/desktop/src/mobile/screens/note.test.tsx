import { page } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { useEffect, useRef, type ReactElement } from 'react'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { useRouter, type NavigateOptions } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileNote } from './note.tsx'

const pmRoot = page.locate('.ProseMirror')

/**
 * Navigates to the note once (a real arrival, so the router's focus intent
 * is set exactly as a wiki-link tap would) and renders the screen the way
 * `MobileScreen` does — keyed by path.
 */
function Arrival({
  path,
  options,
}: {
  path: string
  options?: NavigateOptions | undefined
}): ReactElement | null {
  const { route, navigate } = useRouter()
  const navigatedRef = useRef(false)
  useEffect(() => {
    if (!navigatedRef.current) {
      navigatedRef.current = true
      navigate({ kind: 'note', path }, options)
    }
  })
  return route.kind === 'note' ? <MobileNote key={route.path} path={route.path} /> : null
}

async function renderArrival(path: string, options?: NavigateOptions): Promise<void> {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { 'notes/target.md': '# Target\n' } }),
  })
  await renderInApp(<Arrival path={path} options={options} />, { app })
}

describe('MobileNote focus contract', () => {
  it('labels an existing note screen as edit note', async () => {
    await renderArrival('notes/target.md')
    await expect.element(page.getByRole('heading', { name: 'Edit note' })).toBeVisible()
  })

  it('does not autofocus a plain arrival (no keyboard on browse)', async () => {
    await renderArrival('notes/target.md')
    await expect.element(pmRoot).toBeVisible()
    await expect.element(pmRoot).not.toHaveFocus()
  })

  it('uses the mobile note-body gutter for the editor surface', async () => {
    await renderArrival('notes/target.md')
    await expect.element(pmRoot).toHaveClass('reflect-mobile-content-gutter')
  })

  it('gives the pane a top inset (no date header above a plain note)', async () => {
    await renderArrival('notes/target.md')
    await expect.element(page.getByLabelText('Editing notes/target.md')).toHaveClass('pt-4')
  })

  it('autofocuses a fresh untitled note (the + flow)', async () => {
    await renderArrival(
      createTestCoreServices({
        database: createWasmTestDatabaseService(),
      }).noteCreation.untitledNotePath(),
    )
    await expect.element(page.getByRole('heading', { name: 'New note' })).toBeVisible()
    await expect.element(pmRoot).toHaveFocus()
  })

  it('ignores a focusEditor arrival intent (navigation never raises the keyboard)', async () => {
    await renderArrival('notes/target.md', { focusEditor: true })
    await expect.element(pmRoot).toBeVisible()
    await expect.element(pmRoot).not.toHaveFocus()
  })
})
