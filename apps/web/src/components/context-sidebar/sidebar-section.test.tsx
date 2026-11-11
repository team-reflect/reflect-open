import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createTestCoreServices,
  createTestStorageService,
  type TestStorageService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SidebarSection } from './sidebar-section.tsx'

// One session per test: every mount reads the same storage.
let storage: TestStorageService

async function renderSection() {
  return await renderInApp(
    <SidebarSection storageKey="probe" title="Probe">
      <p>section body</p>
    </SidebarSection>,
    { core: createTestCoreServices({ database: createWasmTestDatabaseService(), storage }) },
  )
}

beforeEach(() => {
  storage = createTestStorageService()
})

describe('SidebarSection', () => {
  it('is open by default with an expanded header', async () => {
    const view = await renderSection()
    await expect
      .element(view.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByText('section body')).toBeInTheDocument()
  })

  it('collapses on header click, unmounting the children', async () => {
    const view = await renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    expect(view.getByText('section body').query()).toBeNull()
    expect(storage.session.get('reflect.context-sidebar.probe')).toBe('closed')
  })

  it('stays collapsed across a remount via sessionStorage', async () => {
    const collapsed = await renderSection()
    await userEvent.click(collapsed.getByRole('button', { name: /Probe/ }))
    await collapsed.unmount()

    const remounted = await renderSection()
    await expect
      .element(remounted.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(remounted.getByText('section body').query()).toBeNull()
  })

  it('persists reopening so the next mount starts open again', async () => {
    storage.session.set('reflect.context-sidebar.probe', 'closed')
    const view = await renderSection()
    const header = view.getByRole('button', { name: /Probe/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(view.getByText('section body')).toBeInTheDocument()
    expect(storage.session.get('reflect.context-sidebar.probe')).toBe('open')
    await view.unmount()

    const remounted = await renderSection()
    await expect
      .element(remounted.getByRole('button', { name: /Probe/ }))
      .toHaveAttribute('aria-expanded', 'true')
  })
})
