import { act } from '@/test-utils/act.ts'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitSyncState, Settings } from '@reflect/core'
import {
  createTestAppInfoService,
  createTestAppStoreService,
  createTestClassicAccessService,
  createTestCoreServices,
  createTestGitSyncService,
  createTestGitHostConnector,
  createTestPlatformService,
  createTestSubscriptionService,
  seedNotes,
  type TestClassicAccessService,
  type TestSubscriptionService,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { TERMS_OF_USE_URL } from '@/mobile/legal-urls.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileSettings } from './settings.tsx'

/**
 * The mobile Settings screen (the pushed card that replaced the bottom
 * sheet): the graph row disclosing into the Graphs screen, appearance and
 * editor preferences writing the shared settings document, the Git repository
 * group's plain-language status + Stop syncing through the sync controller, the
 * one door to a repository, the device's Accounts group, and graceful
 * degradation where the graph runs no sync lifecycle.
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
    remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
    isPrimaryChannel: true,
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
   * The git sync state. `null` runs no sync lifecycle.
   */
  gitSync?: GitSyncState | null
  /**
   * Whether the device is signed in to GitHub. Signed in by default.
   */
  githubSignedIn?: boolean
  /**
   * Run as the iOS app, which adds the Subscription group.
   */
  ios?: boolean
  /**
   * The App Store subscription StoreKit reports; none by default.
   */
  subscription?: TestSubscriptionService
  /**
   * The Reflect Classic grant; none by default.
   */
  classicAccess?: TestClassicAccessService
}

/**
 * The graph "Field Notes" with two indexed notes, on a repository that is connected and idle.
 */
async function mount(options?: MountOptions) {
  const gitSync = createTestGitSyncService({
    state: options?.gitSync ?? connected({ state: 'idle' }),
  })
  const gitHostConnector = createTestGitHostConnector()
  const appStore = createTestAppStoreService()
  const core = createTestCoreServices({
    appStore,
    database: createWasmTestDatabaseService(),
    appInfo: createTestAppInfoService('1.2.3-beta.4'),
    gitSync,
    gitHostConnector,
    // A note window's graph runs no sync lifecycle.
    role: options?.gitSync === null ? 'note-window' : 'main',
    ...(options?.ios ? { platform: createTestPlatformService(MOBILE_PLATFORM) } : {}),
    ...(options?.subscription === undefined ? {} : { subscription: options.subscription }),
    ...(options?.classicAccess === undefined ? {} : { classicAccess: options.classicAccess }),
  })
  if (options?.githubSignedIn !== false) {
    await core.githubAuth.save({ kind: 'pat', token: 'ghp_test' })
  }
  seedNotes(core.database, [
    { path: 'notes/a.md', markdown: '# A\n' },
    { path: 'notes/b.md', markdown: '# B\n' },
  ])
  // Spied before the render: the provider hands this function to the screen.
  const updateSettings = vi.spyOn(core.settings, 'update')
  const view = await renderInApp(<MobileSettings />, {
    core,
    graph: { root: '/g', name: 'Field Notes', generation: 1 },
    mobile: { kind: options?.storageKind ?? 'icloud' },
    route: { kind: 'settings' },
    ...(options?.settings === undefined ? {} : { settings: options.settings }),
  })
  return Object.assign(view, { gitSync, gitHostConnector, updateSettings, appStore })
}

type MountedSettings = Awaited<ReturnType<typeof mount>>

/**
 * Wait until the settings document holds `patch`.
 */
async function expectSettings(view: MountedSettings, patch: Partial<Settings>): Promise<void> {
  await vi.waitFor(() => expect(view.core.settings.get()).toMatchObject(patch))
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
      view.core.settings.update({ chatSystemPrompt: 'Persisted instructions loaded from disk.' })
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
      expect(view.core.settings.get().aiPrompts).toEqual([
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
      expect(view.core.settings.get().aiPrompts).toEqual([
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

    await vi.waitFor(() => expect(view.core.settings.get().aiPrompts).toEqual([]))
  })

  it('shows the connected remote and the live plain-language status', async () => {
    await mount()

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText('Up to date')).toBeVisible()
    // Never git terms.
    await expect.element(page.getByText(/commit|branch|merge|push|pull/i)).not.toBeInTheDocument()
  })

  it('stops syncing through the controller and keeps the GitHub sign-in', async () => {
    const view = await mount()

    await userEvent.click(page.getByRole('button', { name: 'Stop syncing' }))

    await vi.waitFor(() => {
      const methods = view.gitSync.calls().map((call) => call.method)
      expect(methods.filter((method) => method === 'disconnectGraph')).toHaveLength(1)
    })
    expect(view.core.githubAuth.getState().connected).toBe(true)
  })

  it('signs in to and out of GitHub from the account group, on any graph', async () => {
    const view = await mount({ gitSync: { phase: 'disconnected' }, githubSignedIn: false })

    await expect.element(page.getByText('Accounts')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Sign in to GitHub' }))
    await expect.element(page.getByRole('heading', { name: 'Sign in to GitHub' })).toBeVisible()

    await act(() => view.core.githubAuth.save({ kind: 'pat', token: 'ghp_test' }))
    await userEvent.click(page.getByRole('button', { name: 'Sign out of GitHub' }))

    await vi.waitFor(() => expect(view.core.githubAuth.getState().connected).toBe(false))
    await expect.element(page.getByRole('button', { name: 'Sign in to GitHub' })).toBeVisible()
  })

  it('points a GitHub remote that waits for its sign-in at Accounts', async () => {
    await mount({
      gitSync: {
        phase: 'needsCredential',
        remoteUrl: 'https://github.com/alex/notes.git',
        remote: { kind: 'github', repo: { owner: 'alex', name: 'notes' } },
      },
      githubSignedIn: false,
    })

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByText('Sign-in needed')).toBeVisible()
    await expect.element(page.getByText(/Sign in under Accounts to resume/)).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Connect a repository' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Add sign-in' })).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: 'Sign in to GitHub' }))
    await expect.element(page.getByRole('heading', { name: 'Sign in to GitHub' })).toBeVisible()
  })

  it('names a host remote without its user info and adds its sign-in from the sheet', async () => {
    const view = await mount({
      gitSync: {
        phase: 'needsCredential',
        remoteUrl: 'https://alex:s3cret@gitlab.com/alex/notes.git',
        remote: { kind: 'https', origin: 'https://gitlab.com' },
      },
    })

    await expect.element(page.getByText('gitlab.com/alex/notes')).toBeVisible()
    await expect.element(page.getByText(/s3cret/)).not.toBeInTheDocument()
    await expect.element(page.getByText('Sign-in needed')).toBeVisible()
    await expect
      .element(page.getByText('gitlab.com needs a username and an access token or password.'))
      .toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'Add sign-in' }))
    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect
      .element(page.getByLabelText('Repository address'))
      .toHaveValue('https://gitlab.com/alex/notes.git')
    await userEvent.fill(page.getByLabelText('Username'), 'alex')
    await userEvent.fill(page.getByLabelText('Access token or password'), 'glpat-1')
    await userEvent.click(page.getByRole('button', { name: 'Update sign-in', exact: true }))

    await vi.waitFor(() => {
      return expect(view.gitHostConnector.calls()).toEqual([
        { method: 'updateGitHostSignIn', username: 'alex', token: 'glpat-1' },
      ])
    })
    await expect
      .element(page.getByRole('heading', { name: 'Update sign-in' }))
      .not.toBeInTheDocument()
  })

  it('stops syncing a host remote and keeps its sign-in', async () => {
    const view = await mount({
      gitSync: {
        phase: 'connected',
        remoteUrl: 'https://gitlab.com/alex/notes.git',
        remote: { kind: 'https', origin: 'https://gitlab.com' },
        isPrimaryChannel: true,
        status: { state: 'idle' },
      },
    })
    await view.core.gitHostCredentials.save('https://gitlab.com', {
      username: 'alex',
      secret: 'glpat-1',
    })

    await userEvent.click(page.getByRole('button', { name: 'Stop syncing' }))

    await vi.waitFor(() => {
      const methods = view.gitSync.calls().map((call) => call.method)
      expect(methods.filter((method) => method === 'disconnectGraph')).toHaveLength(1)
    })
    expect(await view.core.gitHostCredentials.load('https://gitlab.com')).toEqual({
      origin: 'https://gitlab.com',
      username: 'alex',
      secret: 'glpat-1',
    })
    expect(view.core.githubAuth.getState().connected).toBe(true)
  })

  it('offers to update the sign-in of a host remote the host refused', async () => {
    await mount({
      gitSync: {
        phase: 'connected',
        remoteUrl: 'https://gitlab.com/alex/notes.git',
        remote: { kind: 'https', origin: 'https://gitlab.com' },
        isPrimaryChannel: true,
        status: { state: 'error', errorKind: 'auth', message: 'the host rejected the sign-in' },
      },
    })

    await userEvent.click(page.getByRole('button', { name: 'Update sign-in' }))
    await expect.element(page.getByRole('heading', { name: 'Update sign-in' })).toBeVisible()
    await expect
      .element(page.getByLabelText('Repository address'))
      .toHaveValue('https://gitlab.com/alex/notes.git')
  })

  it('shows a GitHub sign-out that failed under Accounts', async () => {
    const view = await mount({ gitSync: { phase: 'disconnected' } })
    vi.spyOn(view.core.githubAuth, 'clear').mockRejectedValueOnce(new Error('Keychain denied'))

    await userEvent.click(page.getByRole('button', { name: 'Sign out of GitHub' }))

    await expect.element(page.getByText('Keychain denied')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Sign out of GitHub' })).toBeVisible()
  })

  it('offers no sign-in for a plain-HTTP remote', async () => {
    await mount({
      gitSync: {
        phase: 'needsCredential',
        remoteUrl: 'http://gitea.local/alex/notes.git',
        remote: { kind: 'https', origin: 'http://gitea.local' },
      },
    })

    await expect.element(page.getByText(/does not send sign-ins over plain http/)).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Add sign-in' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
  })

  it('connects a repository through one door: GitHub', async () => {
    await mount({ storageKind: 'local', gitSync: { phase: 'disconnected' } })

    await expect
      .element(page.getByText('Sync notes with Reflect on your other devices.'))
      .toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Connect a repository' }))
    await expect.element(page.getByText('Where is the repository?')).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: /^GitHub/ }))
    await expect.element(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible()
  })

  it('connects a repository through one door: another host', async () => {
    const view = await mount({ storageKind: 'local', gitSync: { phase: 'disconnected' } })

    await userEvent.click(page.getByRole('button', { name: 'Connect a repository' }))
    await userEvent.click(page.getByRole('button', { name: 'Other host' }))
    await expect.element(page.getByRole('heading', { name: 'Other host' })).toBeVisible()
    await userEvent.fill(
      page.getByLabelText('Repository address'),
      'https://gitlab.com/alex/notes.git',
    )
    await userEvent.fill(page.getByLabelText('Username'), 'alex')
    await userEvent.fill(page.getByLabelText('Access token or password'), 'glpat-1')
    await userEvent.click(page.getByRole('button', { name: 'Connect', exact: true }))

    await vi.waitFor(() => {
      return expect(view.gitHostConnector.calls()).toEqual([
        {
          method: 'connectGitHost',
          remoteUrl: 'https://gitlab.com/alex/notes.git',
          username: 'alex',
          token: 'glpat-1',
        },
      ])
    })
  })

  it('hides the connect row once the local graph is connected', async () => {
    await mount({ storageKind: 'local' })

    await expect.element(page.getByText('alex/notes on GitHub')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Connect a repository' }))
      .not.toBeInTheDocument()
  })

  it('never offers connect for iCloud graphs — they sync through the container', async () => {
    await mount({ gitSync: { phase: 'disconnected' } })

    await expect
      .element(page.getByRole('button', { name: 'Connect a repository' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Git repository')).not.toBeInTheDocument()
  })

  it('waits out the loading phase — no connect row that could flash', async () => {
    await mount({ storageKind: 'local', gitSync: { phase: 'loading' } })

    await expect
      .element(page.getByRole('button', { name: 'Connect a repository' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('Git repository')).not.toBeInTheDocument()
  })

  it('degrades to the local groups where no sync lifecycle is mounted', async () => {
    await mount({ gitSync: null })

    await expect.element(page.getByText('Field Notes')).toBeVisible()
    await expect.element(page.getByText('1.2.3')).toBeVisible()
    await expect.element(page.getByText('2', { exact: true })).toBeVisible() // the note count
    await expect.element(page.getByText('Up to date')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Stop syncing' })).not.toBeInTheDocument()
  })
})

describe('MobileSettings subscription', () => {
  it('offers Subscribe until a plan is active', async () => {
    await mount({ ios: true })

    await expect.element(page.getByText('Not subscribed')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Subscribe' })).toBeVisible()
    await expect
      .element(page.getByRole('button', { name: 'Manage Subscription' }))
      .not.toBeInTheDocument()
  })

  it('names an App Store plan and opens its management page', async () => {
    const view = await mount({
      ios: true,
      subscription: createTestSubscriptionService({ value: 'yearly' }),
    })

    await expect.element(page.getByText('Yearly')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Manage Subscription' }))
    expect(view.appServices.opener.openedUrls()).toContain(
      'https://apps.apple.com/account/subscriptions',
    )
  })

  it('restores through the App Store and says when nothing was found', async () => {
    const view = await mount({ ios: true })

    await userEvent.click(page.getByRole('button', { name: 'Restore Purchases' }))

    await expect
      .element(page.getByText('No previous purchase found for this Apple account.'))
      .toBeVisible()
    expect(view.appStore.calls()).toContain('sync')
  })

  it('redeems a code through the App Store’s offer code sheet', async () => {
    const view = await mount({ ios: true })

    await userEvent.click(page.getByRole('button', { name: 'Redeem Code' }))

    await vi.waitFor(() => {
      expect(view.appStore.calls()).toContain('presentOfferCodeRedeemSheet')
    })
  })

  it('opens the terms of use', async () => {
    const view = await mount({ ios: true })

    await userEvent.click(page.getByRole('button', { name: 'Terms of Use' }))

    expect(view.appServices.opener.openedUrls()).toContain(TERMS_OF_USE_URL)
  })

  it('names a Reflect Classic grant and removes its verification', async () => {
    const classicAccess = createTestClassicAccessService({
      access: {
        token: 'classic-token',
        email: 'alex@example.com',
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        checkedAt: Date.now(),
      },
      active: true,
      isLoading: false,
    })
    await mount({ ios: true, classicAccess })

    await expect.element(page.getByText(/Reflect Classic, until /)).toBeVisible()
    await expect.element(page.getByText('alex@example.com')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument()
    await userEvent.click(page.getByRole('button', { name: 'Remove Reflect Classic Verification' }))

    await vi.waitFor(() => expect(classicAccess.calls()).toContain('signOut'))
    // The grant is gone, so the group offers the paywall again.
    await expect.element(page.getByText('Not subscribed')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Subscribe' })).toBeVisible()
    await expect.element(page.getByText('alex@example.com')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Remove Reflect Classic Verification' }))
      .not.toBeInTheDocument()
  })
})
