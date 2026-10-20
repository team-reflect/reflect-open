import { act } from '@/test-utils/act.ts'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitSyncState, Settings } from '@reflect/core'
import {
  createTestAppInfoService,
  createTestCoreServices,
  createTestGitSyncService,
  seedNotes,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileSettings } from './settings.tsx'

/**
 * The mobile Settings screen (the pushed card that replaced the bottom
 * sheet): the graph row disclosing into the Graphs screen, appearance and
 * editor preferences writing the shared settings document, the backup group's
 * plain-language status + Disconnect through the backup controller, and
 * graceful degradation where the graph runs no backup.
 */

// The prompt editor's state and save wiring render through this open-state shell.
vi.mock('@/components/ui/drawer.tsx', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: import('react').ReactNode }) => {
    return open ? <div data-testid="drawer">{children}</div> : null
  },
  DrawerContent: ({ children }: { children?: import('react').ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: import('react').ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: import('react').ReactNode }) => <h2>{children}</h2>,
}))

function connected(status: Extract<GitSyncState, { phase: 'connected' }>['status']): GitSyncState {
  return {
    phase: 'connected',
    remoteUrl: 'https://github.com/alex/notes.git',
    repo: { owner: 'alex', name: 'notes' },
    status,
  }
}

interface MountOptions {
  /**
   * The stored settings document; the rest is the defaults.
   */
  settings?: Partial<Settings>
  /**
   * Where the open graph is stored.
   */
  storageKind?: 'icloud' | 'local'
  /**
   * The backup state. `null` runs no backup.
   */
  gitSync?: GitSyncState | null
}

/**
 * The graph "Field Notes" with two indexed notes, on a backup that is connected and idle.
 */
async function mount(options?: MountOptions) {
  const gitSync = createTestGitSyncService({
    state: options?.gitSync ?? connected({ state: 'idle' }),
  })
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    appInfo: createTestAppInfoService('1.2.3-beta.4'),
    gitSync,
    // A note window's graph runs no backup.
    role: options?.gitSync === null ? 'note-window' : 'main',
  })
  seedNotes(app.database, [
    { path: 'notes/a.md', markdown: '# A\n' },
    { path: 'notes/b.md', markdown: '# B\n' },
  ])
  // Spied before the render: the provider hands this function to the screen.
  const updateSettings = vi.spyOn(app.settings, 'update')
  const view = await renderInApp(<MobileSettings />, {
    app,
    graph: { root: '/g', name: 'Field Notes', generation: 1 },
    mobile: { kind: options?.storageKind ?? 'icloud' },
    route: { kind: 'settings' },
    ...(options?.settings === undefined ? {} : { settings: options.settings }),
  })
  return Object.assign(view, { gitSync, updateSettings })
}

type MountedSettings = Awaited<ReturnType<typeof mount>>

/**
 * Wait until the settings document holds `patch`.
 */
async function expectSettings(view: MountedSettings, patch: Partial<Settings>): Promise<void> {
  await vi.waitFor(() => expect(view.app.settings.get()).toMatchObject(patch))
}

beforeEach(async () => {
  await page.viewport(375, 700)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MobileSettings', () => {
  it('discloses the graph row into the Graphs screen', async () => {
    const user = userEvent
    const view = await mount()

    const graphRow = page.getByRole('button', { name: /Field Notes/ })
    await expect.element(graphRow).toMatchTextContent('iCloud Drive')
    await user.click(graphRow)

    expect(view.appServices.navigation.navigations()).toEqual([
      { route: { kind: 'graphs' }, options: undefined },
    ])
  })

  it('discloses Open Source Licenses into the Licenses screen', async () => {
    const view = await mount()

    await userEvent.click(page.getByRole('button', { name: 'Open Source Licenses' }))

    expect(view.appServices.navigation.navigations()).toEqual([
      { route: { kind: 'licenses' }, options: undefined },
    ])
  })

  it('opens the privacy policy from the About group', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: 'Privacy Policy' }))

    await vi.waitFor(() => {
      expect(view.appServices.opener.openedUrls()).toEqual(['https://reflect.app/privacy'])
    })
  })

  it('writes appearance choices to the settings document', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('radio', { name: 'Dark' }))
    await expectSettings(view, { theme: 'dark' })

    await user.click(page.getByRole('radio', { name: 'Large' }))
    await expectSettings(view, { editorTextSize: 'large' })
  })

  it('offers each date format as today in that format and writes the choice', async () => {
    const user = userEvent
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 5, 9))
    const view = await mount()

    const selected = page.getByRole('button', { name: 'June 9th, 2026' })
    await expect.element(selected).toHaveAttribute('aria-current', 'true')

    await user.click(page.getByRole('button', { name: '9th June, 2026' }))
    await expectSettings(view, { dateFormat: 'dmy' })

    await user.click(page.getByRole('button', { name: '2026-06-09' }))
    await expectSettings(view, { dateFormat: 'iso' })
  })

  it('shows the saved week start and time format and writes a new choice', async () => {
    const user = userEvent
    const view = await mount()

    await expect.element(page.getByRole('radio', { name: 'Monday' })).toBeChecked()
    await expect.element(page.getByRole('radio', { name: '12-hour' })).toBeChecked()

    await user.click(page.getByRole('radio', { name: 'Sunday' }))
    await expectSettings(view, { weekStartDay: 'sunday' })

    await user.click(page.getByRole('radio', { name: '24-hour' }))
    await expectSettings(view, { timeFormat: '24h' })
  })

  it('toggles the editor switches', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('switch', { name: 'Smooth caret animation' }))
    await expectSettings(view, { editorSmoothCaretAnimation: false })

    await user.click(page.getByRole('switch', { name: 'Start with a bullet' }))
    await expectSettings(view, { editorDefaultBullet: false })

    await user.click(page.getByRole('switch', { name: 'Bullet after a heading' }))
    await expectSettings(view, { editorBulletAfterHeading: false })
  })

  it('toggles audio transcription formatting', async () => {
    const user = userEvent
    const view = await mount()

    const toggle = page.getByRole('switch', { name: 'Transcription auto-format' })
    const descriptionId = toggle.element().getAttribute('aria-describedby')
    expect(descriptionId).not.toBeNull()
    expect(document.getElementById(descriptionId ?? '')?.textContent).toContain(
      'Uses AI to add punctuation, paragraphs, and light Markdown',
    )

    await user.click(toggle)

    await expectSettings(view, { transcriptionFormat: false })
  })

  it('edits the AI chat system prompt', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: /System prompt.*Default/ }))
    const textarea = page.getByRole('textbox', { name: 'System prompt instructions' })
    await user.type(textarea, 'Challenge my assumptions.')
    await user.click(page.getByRole('button', { name: 'Save' }))

    await expectSettings(view, {
      chatSystemPrompt: 'Challenge my assumptions.',
    })
  })

  it('edits the transcription helper text', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: /Helper text.*None/ }))
    const textarea = page.getByRole('textbox', { name: 'Transcription helper text' })
    await user.type(textarea, ' Names: Ocavue ')
    await user.click(page.getByRole('button', { name: 'Save' }))

    await expectSettings(view, { transcriptionPrompt: 'Names: Ocavue' })
  })

  it('shows Custom once a transcription helper text is stored', async () => {
    await mount({ settings: { transcriptionPrompt: 'Ocavue' } })

    await expect
      .element(page.getByRole('button', { name: /Helper text.*Custom/ }))
      .toBeInTheDocument()
  })

  it('warns when the transcription helper text is over the limit', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: /Helper text.*None/ }))
    const textarea = page.getByRole('textbox', { name: 'Transcription helper text' })
    await user.fill(textarea, 'x'.repeat(510))

    await expect.element(textarea).toHaveAttribute('aria-invalid', 'true')
    await expect
      .element(page.getByRole('alert'))
      .toMatchTextContent('10 characters over the 500-character limit')

    await user.click(page.getByRole('button', { name: 'Save' }))

    await expectSettings(view, { transcriptionPrompt: 'x'.repeat(500) })
  })

  it('tracks a prompt that hydrates while its editor is open', async () => {
    const user = userEvent
    const view = await mount()
    await user.click(page.getByRole('button', { name: /System prompt.*Default/ }))

    await act(() => {
      view.app.settings.update({ chatSystemPrompt: 'Persisted instructions loaded from disk.' })
    })
    view.updateSettings.mockClear()

    const textarea = page.getByRole('textbox', { name: 'System prompt instructions' })
    await expect.element(textarea).toHaveValue('Persisted instructions loaded from disk.')
    await user.click(page.getByRole('button', { name: 'Save' }))
    expect(view.updateSettings).toHaveBeenCalledWith({
      chatSystemPrompt: 'Persisted instructions loaded from disk.',
    })
  })

  it('clears the prompt immediately from the mobile editor', async () => {
    const user = userEvent
    const view = await mount({ settings: { chatSystemPrompt: 'Always answer in haiku.' } })

    await user.click(page.getByRole('button', { name: /System prompt.*Custom/ }))
    await user.click(page.getByRole('button', { name: 'Clear' }))

    await expectSettings(view, { chatSystemPrompt: '' })
    await expect
      .element(page.getByRole('textbox', { name: 'System prompt instructions' }))
      .not.toBeInTheDocument()
  })

  it('adds a saved AI prompt from the AI prompts group', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: 'Add prompt' }))
    const sheet = page.getByTestId('drawer')
    await user.fill(sheet.getByRole('textbox', { name: 'Label' }), 'Shorten')
    await user.fill(sheet.getByRole('textbox', { name: 'Prompt' }), 'Shorten: {{selectedText}}')
    await user.click(sheet.getByRole('button', { name: 'Add prompt' }))

    await vi.waitFor(() => {
      expect(view.app.settings.get().aiPrompts).toEqual([
        expect.objectContaining({
          label: 'Shorten',
          body: 'Shorten: {{selectedText}}',
          mode: 'replace',
        }),
      ])
    })
  })

  it('edits a saved AI prompt through its row', async () => {
    const user = userEvent
    const saved = {
      id: 'p1',
      label: 'Translate to French',
      body: 'Translate: {{selectedText}}',
      mode: 'replace' as const,
    }
    const view = await mount({ settings: { aiPrompts: [saved] } })

    await user.click(page.getByRole('button', { name: 'Translate to French' }))
    const sheet = page.getByTestId('drawer')
    await user.fill(sheet.getByRole('textbox', { name: 'Label' }), 'Translate to German')
    await user.click(sheet.getByRole('button', { name: 'Save' }))

    await vi.waitFor(() => {
      expect(view.app.settings.get().aiPrompts).toEqual([
        { ...saved, label: 'Translate to German' },
      ])
    })
  })

  it('removes a saved AI prompt from the edit sheet', async () => {
    const user = userEvent
    const view = await mount({
      settings: {
        aiPrompts: [{ id: 'p1', label: 'Shorten', body: 'Shorten this.', mode: 'replace' }],
      },
    })

    await user.click(page.getByRole('button', { name: 'Shorten' }))
    await user.click(page.getByTestId('drawer').getByRole('button', { name: 'Remove' }))

    await vi.waitFor(() => expect(view.app.settings.get().aiPrompts).toEqual([]))
  })

  it('shows the connected repo and the live plain-language status', async () => {
    await mount()

    await expect.element(page.getByText('alex/notes')).toBeVisible()
    await expect.element(page.getByText('Backed up')).toBeVisible()
    // Never git terms.
    await expect.element(page.getByText(/commit|branch|merge|push|pull/i)).not.toBeInTheDocument()
  })

  it('routes Disconnect through the backup controller and signs out', async () => {
    const user = userEvent
    const view = await mount()

    await user.click(page.getByRole('button', { name: 'Disconnect GitHub' }))

    await vi.waitFor(() => {
      const methods = view.gitSync.calls().map((call) => call.method)
      expect(methods.filter((method) => method === 'disconnectGraph')).toHaveLength(1)
      expect(methods.filter((method) => method === 'signOut')).toHaveLength(1)
    })
  })

  it('offers Connect GitHub for a disconnected local graph and opens the sheet', async () => {
    const user = userEvent
    await mount({ storageKind: 'local', gitSync: { phase: 'disconnected' } })

    await expect
      .element(page.getByText('Sync notes with Reflect on your other devices.'))
      .toBeVisible()
    await user.click(page.getByRole('button', { name: 'Connect GitHub' }))

    await expect.element(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible()
  })

  it('hides the connect row once the local graph is connected', async () => {
    await mount({ storageKind: 'local' })

    await expect.element(page.getByText('alex/notes')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Disconnect GitHub' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub', exact: true }))
      .not.toBeInTheDocument()
  })

  it('never offers connect for iCloud graphs — they sync through the container', async () => {
    await mount({ gitSync: { phase: 'disconnected' } })

    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Backup')).not.toBeInTheDocument()
  })

  it('waits out the loading phase — no connect row that could flash', async () => {
    await mount({ storageKind: 'local', gitSync: { phase: 'loading' } })

    await expect
      .element(page.getByRole('button', { name: 'Connect GitHub' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Backup')).not.toBeInTheDocument()
  })

  it('degrades to the local groups where no sync lifecycle is mounted', async () => {
    await mount({ gitSync: null })

    await expect.element(page.getByText('Field Notes')).toBeVisible()
    await expect.element(page.getByText('1.2.3')).toBeVisible()
    await expect.element(page.getByText('2', { exact: true })).toBeVisible() // the note count
    await expect.element(page.getByText('Backed up')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Disconnect GitHub' }))
      .not.toBeInTheDocument()
  })
})
