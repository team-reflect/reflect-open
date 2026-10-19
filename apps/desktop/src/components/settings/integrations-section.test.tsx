import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@reflect/core'
import type { TestOpenerService } from '@reflect/app/testing'
import {
  createTestCoreServices,
  createTestContactsService,
  createTestPlatformService,
  type TestContactsService,
  type TestPlatformOptions,
  type TestSettingsService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { IntegrationsSection } from './integrations-section.tsx'

let contacts: TestContactsService
// Where the section runs; the calendar field exists on macOS desktop only.
let platform: TestPlatformOptions

// The services of the rendered app; set by `renderSection`.
let opener: TestOpenerService
let settings: TestSettingsService

/**
 * Render the section over a settings document that starts as `stored`.
 */
async function renderSection(stored: Partial<Settings> = {}): Promise<void> {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    contacts,
    platform: createTestPlatformService(platform),
  })
  ;({ settings } = app)
  const view = await renderInApp(<IntegrationsSection />, { app, settings: stored })
  opener = view.appServices.opener
}

beforeEach(() => {
  platform = { isMacosDesktop: false }
  contacts = createTestContactsService({ status: 'notDetermined' })
})

describe('IntegrationsSection', () => {
  it('enabling persists the opt-in and triggers the permission prompt', async () => {
    await renderSection()
    await page.getByRole('switch', { name: 'Contacts' }).click()

    await vi.waitFor(() => expect(contacts.accessRequests()).toBe(1))
    expect(settings.get().contactsEnabled).toBe(true)
  })

  it('disabling persists without touching the permission', async () => {
    contacts.setStatus('authorized')
    await renderSection({ contactsEnabled: true })
    await page.getByRole('switch', { name: 'Contacts' }).click()

    await vi.waitFor(() => expect(settings.get().contactsEnabled).toBe(false))
    expect(contacts.accessRequests()).toBe(0)
  })

  it('offers the prompt again when enabled but never asked (e.g. after a restart)', async () => {
    await renderSection({ contactsEnabled: true })

    await page.getByRole('button', { name: 'Allow contacts access' }).click()
    await vi.waitFor(() => expect(contacts.accessRequests()).toBe(1))
  })

  it('points a denied permission at System Settings', async () => {
    contacts.setStatus('denied')
    await renderSection({ contactsEnabled: true })

    await page.getByRole('button', { name: 'Open System Settings' }).click()
    await vi.waitFor(() =>
      expect(opener.openedUrls()).toEqual([
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts',
      ]),
    )
  })

  it('renders nothing where the Contacts framework does not exist', async () => {
    contacts.setStatus('unavailable')
    await renderSection()
    await vi.waitFor(() => expect(page.getByRole('switch').query()).toBeNull())
    expect(page.getByText('Integrations').query()).toBeNull()
  })
})

describe('IntegrationsSection on macOS', () => {
  it('keeps calendar visible on macOS when contacts are unavailable', async () => {
    platform = {}
    contacts.setStatus('unavailable')
    await renderSection()

    await expect.element(page.getByText('Calendar events')).toBeInTheDocument()
    expect(page.getByRole('switch', { name: 'Contacts' }).query()).toBeNull()
  })
})
