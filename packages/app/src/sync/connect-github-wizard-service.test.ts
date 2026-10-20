import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, type ConnectExistingResult, type GithubAuth } from '@reflect/core'
import {
  createTestGitSyncService,
  createTestClockService,
  createTestGithubAuthService,
  type TestGitSyncService,
  type TestClockService,
} from '@reflect/core/testing'
import { createTestLifecycleService, type TestLifecycleService } from '../testing/lifecycle.ts'
import { createTestOpenerService, type TestOpenerService } from '../testing/opener.ts'
import {
  createConnectGithubWizardService,
  type ConnectGithubWizardService,
} from './connect-github-wizard-service.ts'

const ALEX = { login: 'alex', avatarUrl: null }
const PAT: GithubAuth = { kind: 'pat', token: 'ghp_abc' }
const APP: GithubAuth = {
  kind: 'app',
  accessToken: 'ghu_live',
  refreshToken: 'ghr_live',
  expiresAt: 60 * 60 * 1000,
}
const POLL_MS = 3000

let clock: TestClockService
let lifecycle: TestLifecycleService
let opener: TestOpenerService
let gitSync: TestGitSyncService
let onClose: ReturnType<typeof vi.fn<() => void>>

beforeEach(() => {
  clock = createTestClockService()
  lifecycle = createTestLifecycleService()
  opener = createTestOpenerService()
  gitSync = createTestGitSyncService()
  onClose = vi.fn<() => void>()
})

/**
 * Answer each `connectExistingRepo` call with the next result; the last one repeats.
 */
function scriptExisting(...results: ConnectExistingResult[]): void {
  let call = 0
  gitSync.onConnectExistingRepo(() => {
    const result = results[Math.min(call, results.length - 1)] ?? 'connected'
    call += 1
    return Promise.resolve(result)
  })
}

function existingCalls(): unknown[] {
  return gitSync.calls().filter((call) => call.method === 'connectExistingRepo')
}

function createWizard(auth: GithubAuth = PAT): ConnectGithubWizardService {
  return createConnectGithubWizardService(
    {
      connect: gitSync,
      githubAuth: createTestGithubAuthService({ auth }),
      opener,
      lifecycle,
      clock,
    },
    { suggestedRepoName: 'g-backup', onClose },
  )
}

/**
 * Let every promise chain that is already runnable settle.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Move the clock by `ms`, running the timers that come due, then settle.
 */
async function advance(ms: number): Promise<void> {
  await clock.advance(ms)
  await flush()
}

/**
 * Sign in as alex and let the connect attempt settle.
 */
async function signIn(wizard: ConnectGithubWizardService): Promise<void> {
  wizard.continueFromRepo()
  wizard.onAuthed(ALEX)
  await flush()
}

describe('createConnectGithubWizardService', () => {
  it('starts on the repo step with the suggested name', () => {
    const wizard = createWizard()
    expect(wizard.getState()).toEqual({
      step: 'repo',
      mode: 'create',
      repoName: 'g-backup',
      existingRepo: '',
      user: null,
      authKind: null,
      finishView: { kind: 'idle' },
      pending: false,
      error: null,
    })
  })

  it('refuses to leave the repo step without a usable repository', () => {
    const wizard = createWizard()
    wizard.setRepoName('   ')
    wizard.continueFromRepo()
    expect(wizard.getState()).toMatchObject({ step: 'repo', error: 'Name the repository.' })

    wizard.setMode('existing')
    wizard.setExistingRepo('not a repo')
    wizard.continueFromRepo()
    expect(wizard.getState()).toMatchObject({
      step: 'repo',
      error: 'Enter the repository as owner/name or a GitHub URL.',
    })

    wizard.setExistingRepo('alex/notes')
    wizard.continueFromRepo()
    expect(wizard.getState()).toMatchObject({ step: 'auth', error: null })
  })

  it('notifies subscribers on every change until they unsubscribe', () => {
    const wizard = createWizard()
    const listener = vi.fn()
    const unsubscribe = wizard.subscribe(listener)
    const before = wizard.getState()

    wizard.setRepoName('other')
    expect(listener).toHaveBeenCalledOnce()
    expect(wizard.getState()).not.toBe(before)

    unsubscribe()
    wizard.setRepoName('again')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('connects an existing repo under the signed-in owner and closes', async () => {
    const wizard = createWizard()
    wizard.setRepoName('  my-notes  ')
    await signIn(wizard)

    // The owner is the verified sign-in — never typed.
    expect(gitSync.calls()).toEqual([
      {
        method: 'connectExistingRepo',
        ref: { owner: 'alex', name: 'my-notes' },
        allowPublic: false,
      },
    ])
    expect(onClose).toHaveBeenCalledOnce()
    expect(wizard.getState()).toMatchObject({
      step: 'finish',
      user: ALEX,
      authKind: 'pat',
      pending: false,
      error: null,
    })
  })

  it('shows connecting while the connect is in flight', async () => {
    const gate = Promise.withResolvers<ConnectExistingResult>()
    gitSync.onConnectExistingRepo(() => gate.promise)
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.getState()).toMatchObject({ pending: true, finishView: { kind: 'connecting' } })
    gate.resolve('connected')
    await flush()
    expect(wizard.getState()).toMatchObject({ pending: false, finishView: { kind: 'idle' } })
  })

  it('API-creates a new repo that does not exist yet and closes', async () => {
    scriptExisting('notFound')
    const wizard = createWizard()
    await signIn(wizard)

    expect(gitSync.calls().at(-1)).toEqual({ method: 'connectNewRepo', name: 'g-backup' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('hands off to github.com/new and connects by polling — no button to click', async () => {
    scriptExisting('notFound', 'notFound', 'connected')
    gitSync.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
    const wizard = createWizard()
    const detach = wizard.attach()
    await signIn(wizard)

    expect(wizard.getState().finishView).toEqual({
      kind: 'createGuide',
      owner: 'alex',
      name: 'g-backup',
    })
    expect(existingCalls()).toHaveLength(1)

    // The first poll comes one interval after the handoff, not at once.
    await advance(POLL_MS - 1)
    expect(existingCalls()).toHaveLength(1)
    await advance(1)
    expect(existingCalls()).toHaveLength(2)
    expect(onClose).not.toHaveBeenCalled()

    await advance(POLL_MS)
    expect(existingCalls()).toHaveLength(3)
    expect(onClose).toHaveBeenCalledOnce()

    // Connected: the loop ended for good.
    await advance(POLL_MS * 3)
    expect(existingCalls()).toHaveLength(3)
    detach()
  })

  it('opens the prefilled github.com/new page for the chosen name', async () => {
    const wizard = createWizard()
    wizard.setRepoName(' my notes ')
    wizard.openCreatePage()
    wizard.openInstallPage()
    await flush()

    expect(opener.openedUrls()).toHaveLength(2)
    expect(opener.openedUrls()[0]).toContain('github.com/new')
    expect(opener.openedUrls()[0]).toContain('my')
    expect(wizard.getState().error).toBeNull()
  })

  it('surfaces the URL to visit by hand when the browser cannot open', async () => {
    opener.failWith(new AppError('io', 'no handler'))
    const wizard = createWizard()
    wizard.openInstallPage()
    await flush()

    expect(wizard.getState().error).toMatch(
      /^Couldn’t open the browser — visit https:\/\/.* yourself\.$/,
    )
  })

  it('an app sign-in that cannot see the repo lands on grant access and polls', async () => {
    scriptExisting('notFound', 'connected')
    const wizard = createWizard(APP)
    const detach = wizard.attach()
    wizard.setMode('existing')
    wizard.setExistingRepo('team/notes')
    await signIn(wizard)

    expect(wizard.getState()).toMatchObject({
      authKind: 'app',
      error: null,
      finishView: { kind: 'grantAccess', repo: { owner: 'team', name: 'notes' } },
    })
    expect(gitSync.calls().some((call) => call.method === 'connectNewRepo')).toBe(false)

    await advance(POLL_MS)
    expect(onClose).toHaveBeenCalledOnce()
    detach()
  })

  it('a PAT sign-in that cannot see the repo gets token-scope guidance, no poll', async () => {
    scriptExisting('notFound')
    const wizard = createWizard(PAT)
    const detach = wizard.attach()
    wizard.setMode('existing')
    wizard.setExistingRepo('team/notes')
    await signIn(wizard)

    expect(wizard.getState()).toMatchObject({
      finishView: { kind: 'idle' },
      error: 'Repository not found. Check the name and your token’s repository access.',
    })
    await advance(POLL_MS * 2)
    expect(existingCalls()).toHaveLength(1)
    expect(clock.pendingTimers()).toBe(0)
    detach()
  })

  it('demands explicit consent before connecting a public repo', async () => {
    scriptExisting('needsPublicConfirm', 'connected')
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.getState().finishView).toEqual({
      kind: 'publicConfirm',
      repo: { owner: 'alex', name: 'g-backup' },
    })
    expect(onClose).not.toHaveBeenCalled()

    wizard.confirmPublic()
    await flush()
    expect(gitSync.calls().at(-1)).toEqual({
      method: 'connectExistingRepo',
      ref: { owner: 'alex', name: 'g-backup' },
      allowPublic: true,
    })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('a poll that finds a public repo stops for consent', async () => {
    scriptExisting('notFound', 'needsPublicConfirm')
    gitSync.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
    const wizard = createWizard()
    const detach = wizard.attach()
    await signIn(wizard)

    await advance(POLL_MS)
    // The consent question outranks the create guide, and the poll is over.
    expect(wizard.getState().finishView).toMatchObject({ kind: 'publicConfirm' })
    await advance(POLL_MS * 3)
    expect(existingCalls()).toHaveLength(2)
    expect(clock.pendingTimers()).toBe(0)
    detach()
  })

  it('back to the repo step clears every parked handoff', async () => {
    scriptExisting('notFound')
    gitSync.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
    const wizard = createWizard()
    const detach = wizard.attach()
    await signIn(wizard)
    expect(wizard.getState().finishView).toMatchObject({ kind: 'createGuide' })

    wizard.backToRepo()
    expect(wizard.getState()).toMatchObject({
      step: 'repo',
      error: null,
      finishView: { kind: 'idle' },
    })
    await advance(POLL_MS * 2)
    expect(existingCalls()).toHaveLength(1)
    detach()
  })

  it('captures a failed connect as a display message', async () => {
    gitSync.onConnectExistingRepo(() => {
      return Promise.reject(new AppError('auth', 'Connect GitHub first (no credential stored)'))
    })
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.getState()).toMatchObject({
      pending: false,
      error: 'Connect GitHub first (no credential stored)',
      finishView: { kind: 'idle' },
    })
    expect(onClose).not.toHaveBeenCalled()
  })

  describe('the repo-existence poll', () => {
    async function parkOnCreateGuide(): Promise<ConnectGithubWizardService> {
      scriptExisting('notFound')
      gitSync.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
      const wizard = createWizard()
      await signIn(wizard)
      expect(wizard.getState().finishView).toMatchObject({ kind: 'createGuide' })
      return wizard
    }

    it('runs only while the wizard is attached', async () => {
      const wizard = await parkOnCreateGuide()
      await advance(POLL_MS * 2)
      expect(existingCalls()).toHaveLength(1)

      const detach = wizard.attach()
      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(2)

      detach()
      await advance(POLL_MS * 2)
      expect(existingCalls()).toHaveLength(2)
      expect(clock.pendingTimers()).toBe(0)
    })

    it('never overlaps ticks: the next wait starts when the tick settles', async () => {
      const wizard = await parkOnCreateGuide()
      const gate = Promise.withResolvers<ConnectExistingResult>()
      gitSync.onConnectExistingRepo(() => gate.promise)
      const detach = wizard.attach()

      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(2)
      await advance(POLL_MS * 3)
      expect(existingCalls()).toHaveLength(2)

      gate.resolve('notFound')
      await flush()
      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(3)
      detach()
    })

    it('a failing tick keeps the loop alive', async () => {
      const wizard = await parkOnCreateGuide()
      gitSync.onConnectExistingRepo(() => Promise.reject(new AppError('network', 'offline')))
      const detach = wizard.attach()

      await advance(POLL_MS)
      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(3)
      // A poll failure is silent: the handoff stays on screen.
      expect(wizard.getState()).toMatchObject({ error: null, finishView: { kind: 'createGuide' } })
      detach()
    })

    it('pauses while hidden and resumes with an immediate tick on return', async () => {
      const wizard = await parkOnCreateGuide()
      const detach = wizard.attach()

      lifecycle.emitHidden()
      await advance(POLL_MS * 3)
      expect(existingCalls()).toHaveLength(1)

      lifecycle.emitVisible()
      expect(existingCalls()).toHaveLength(2)
      detach()
    })

    it('does not start a wait while hidden', async () => {
      lifecycle.setHidden(true)
      const wizard = await parkOnCreateGuide()
      const detach = wizard.attach()
      expect(clock.pendingTimers()).toBe(0)

      lifecycle.emitVisible()
      expect(existingCalls()).toHaveLength(2)
      detach()
    })

    it("a tick's stop ends the loop for good, across hide and show", async () => {
      const wizard = await parkOnCreateGuide()
      scriptExisting('connected')
      const detach = wizard.attach()
      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(2)

      lifecycle.emitHidden()
      lifecycle.emitVisible()
      await advance(POLL_MS * 2)
      expect(existingCalls()).toHaveLength(2)
      detach()
    })
  })
})
