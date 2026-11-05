import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError, type ConnectExistingResult, type GithubAuth } from '@reflect/core'
import {
  createTestGithubConnector,
  createTestClockService,
  createTestGithubAuthService,
  type GithubConnectorCall,
  type TestGithubConnector,
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
let connector: TestGithubConnector
let detach: () => void

beforeEach(() => {
  clock = createTestClockService()
  lifecycle = createTestLifecycleService()
  opener = createTestOpenerService()
  connector = createTestGithubConnector()
})

/**
 * Answer each `connectExistingRepo` call with the next result; the last one repeats.
 */
function scriptExisting(...results: ConnectExistingResult[]): void {
  let call = 0
  connector.onConnectExistingRepo(() => {
    const result = results[Math.min(call, results.length - 1)] ?? 'connected'
    call += 1
    return Promise.resolve(result)
  })
}

type ExistingCall = Extract<GithubConnectorCall, { method: 'connectExistingRepo' }>

function existingCalls(): ExistingCall[] {
  return connector
    .calls()
    .filter((call): call is ExistingCall => call.method === 'connectExistingRepo')
}

/**
 * A mounted wizard; `detach` unmounts it.
 */
function createWizard(auth: GithubAuth = PAT): ConnectGithubWizardService {
  const wizard = createConnectGithubWizardService(
    {
      connector,
      githubAuth: createTestGithubAuthService({ auth }),
      opener,
      lifecycle,
      clock,
    },
    { suggestedRepoName: 'g-backup' },
  )
  detach = wizard.attach()
  return wizard
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

/**
 * Sign in with a new repo that the token cannot create, parking on the create guide.
 */
async function parkOnCreateGuide(wizard: ConnectGithubWizardService): Promise<void> {
  connector.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
  await signIn(wizard)
  expect(wizard.get()).toMatchObject({ step: 'finish', view: { kind: 'createGuide' } })
}

describe('createConnectGithubWizardService', () => {
  it('starts on the repo step with the suggested name', () => {
    const wizard = createWizard()
    expect(wizard.get()).toEqual({
      step: 'repo',
      mode: 'create',
      repoName: 'g-backup',
      existingRepo: '',
      error: null,
    })
  })

  it('refuses to leave the repo step without a usable repository', () => {
    const wizard = createWizard()
    wizard.setRepoName('   ')
    wizard.continueFromRepo()
    expect(wizard.get()).toMatchObject({ step: 'repo', error: 'Name the repository.' })

    wizard.setMode('existing')
    wizard.setExistingRepo('not a repo')
    wizard.continueFromRepo()
    expect(wizard.get()).toMatchObject({
      step: 'repo',
      error: 'Enter the repository as owner/name or a GitHub URL.',
    })

    wizard.setExistingRepo('alex/notes')
    wizard.continueFromRepo()
    expect(wizard.get()).toEqual({
      step: 'auth',
      choice: { kind: 'existing', ref: { owner: 'alex', name: 'notes' } },
    })
  })

  it('notifies subscribers on every change until they unsubscribe', () => {
    const wizard = createWizard()
    const listener = vi.fn()
    const unsubscribe = wizard.subscribe(listener)
    const before = wizard.get()
    expect(wizard.get()).toBe(before)

    wizard.setRepoName('other')
    expect(listener).toHaveBeenCalledOnce()
    expect(wizard.get()).not.toBe(before)

    unsubscribe()
    wizard.setRepoName('again')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('connects an existing repo under the signed-in owner', async () => {
    const wizard = createWizard()
    wizard.setRepoName('  my-notes  ')
    await signIn(wizard)

    // The owner is the verified sign-in — never typed.
    expect(connector.calls()).toEqual([
      {
        method: 'connectExistingRepo',
        ref: { owner: 'alex', name: 'my-notes' },
        allowPublic: false,
      },
    ])
    expect(wizard.get()).toEqual({ step: 'connected' })
  })

  it('shows connecting while the connect is in flight', async () => {
    const gate = Promise.withResolvers<ConnectExistingResult>()
    connector.onConnectExistingRepo(() => gate.promise)
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.get()).toEqual({
      step: 'finish',
      user: ALEX,
      view: { kind: 'connecting' },
      openError: null,
    })
    gate.resolve('connected')
    await flush()
    expect(wizard.get().step).toBe('connected')
  })

  it('API-creates a new repo that does not exist yet', async () => {
    scriptExisting('notFound')
    const wizard = createWizard()
    await signIn(wizard)

    expect(connector.calls().at(-1)).toEqual({ method: 'connectNewRepo', name: 'g-backup' })
    expect(wizard.get().step).toBe('connected')
  })

  it('hands off to github.com/new and connects by polling — no button to click', async () => {
    scriptExisting('notFound', 'notFound', 'connected')
    const wizard = createWizard()
    await parkOnCreateGuide(wizard)

    expect(wizard.get()).toMatchObject({
      view: { kind: 'createGuide', repo: { owner: 'alex', name: 'g-backup' }, authKind: 'pat' },
    })
    expect(existingCalls()).toHaveLength(1)

    // The first poll comes one interval after the handoff, not at once.
    await advance(POLL_MS - 1)
    expect(existingCalls()).toHaveLength(1)
    await advance(1)
    expect(existingCalls()).toHaveLength(2)
    expect(wizard.get().step).toBe('finish')

    await advance(POLL_MS)
    expect(existingCalls()).toHaveLength(3)
    expect(wizard.get().step).toBe('connected')

    // Connected: the poll ended for good.
    await advance(POLL_MS * 3)
    expect(existingCalls()).toHaveLength(3)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('opens the prefilled github.com/new page and the install page', async () => {
    scriptExisting('notFound')
    const wizard = createWizard()
    wizard.setRepoName(' my notes ')
    await parkOnCreateGuide(wizard)
    wizard.openCreatePage()
    wizard.openInstallPage()
    await flush()

    expect(opener.openedUrls()).toHaveLength(2)
    expect(opener.openedUrls()[0]).toContain('github.com/new')
    expect(opener.openedUrls()[0]).toContain('my')
    expect(wizard.get()).toMatchObject({ openError: null })
    wizard.backToRepo()
  })

  it('surfaces the URL to visit by hand when the browser cannot open', async () => {
    scriptExisting('notFound')
    opener.failWith(new AppError('io', 'no handler'))
    const wizard = createWizard()
    await parkOnCreateGuide(wizard)
    wizard.openInstallPage()
    await flush()

    const state = wizard.get()
    expect(state).toMatchObject({ view: { kind: 'createGuide' } })
    expect(state.step === 'finish' ? state.openError : null).toMatch(
      /^Couldn’t open the browser — visit https:\/\/.* yourself\.$/,
    )
    wizard.backToRepo()
  })

  it('an app sign-in that cannot see the repo lands on grant access and polls', async () => {
    scriptExisting('notFound', 'connected')
    const wizard = createWizard(APP)
    wizard.setMode('existing')
    wizard.setExistingRepo('team/notes')
    await signIn(wizard)

    expect(wizard.get()).toMatchObject({
      view: { kind: 'grantAccess', repo: { owner: 'team', name: 'notes' } },
    })
    expect(connector.calls().some((call) => call.method === 'connectNewRepo')).toBe(false)

    await advance(POLL_MS)
    expect(wizard.get().step).toBe('connected')
  })

  it('a PAT sign-in that cannot see the repo gets token-scope guidance, no poll', async () => {
    scriptExisting('notFound')
    const wizard = createWizard(PAT)
    wizard.setMode('existing')
    wizard.setExistingRepo('team/notes')
    await signIn(wizard)

    expect(wizard.get()).toMatchObject({
      view: {
        kind: 'failed',
        error: 'Repository not found. Check the name and your token’s repository access.',
      },
    })
    await advance(POLL_MS * 2)
    expect(existingCalls()).toHaveLength(1)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('demands explicit consent before connecting a public repo', async () => {
    scriptExisting('needsPublicConfirm', 'connected')
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.get()).toMatchObject({
      view: { kind: 'publicConfirm', repo: { owner: 'alex', name: 'g-backup' } },
    })

    wizard.confirmPublic()
    expect(wizard.get()).toMatchObject({ view: { kind: 'connecting' } })
    await flush()
    expect(connector.calls().at(-1)).toEqual({
      method: 'connectExistingRepo',
      ref: { owner: 'alex', name: 'g-backup' },
      allowPublic: true,
    })
    expect(wizard.get().step).toBe('connected')
  })

  it('a poll that finds a public repo stops for consent', async () => {
    scriptExisting('notFound', 'needsPublicConfirm')
    const wizard = createWizard()
    await parkOnCreateGuide(wizard)

    await advance(POLL_MS)
    expect(wizard.get()).toMatchObject({ view: { kind: 'publicConfirm' } })
    await advance(POLL_MS * 3)
    expect(existingCalls()).toHaveLength(2)
    expect(clock.pendingTimers()).toBe(0)
    wizard.backToRepo()
  })

  it('back to the repo step stops the poll and keeps the input', async () => {
    scriptExisting('notFound')
    const wizard = createWizard()
    wizard.setRepoName('my-notes')
    await parkOnCreateGuide(wizard)

    wizard.backToRepo()
    expect(wizard.get()).toEqual({
      step: 'repo',
      mode: 'create',
      repoName: 'my-notes',
      existingRepo: '',
      error: null,
    })
    await advance(POLL_MS * 2)
    expect(existingCalls()).toHaveLength(1)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('captures a failed connect as a display message', async () => {
    connector.onConnectExistingRepo(() => {
      return Promise.reject(new AppError('auth', 'Connect GitHub first (no credential stored)'))
    })
    const wizard = createWizard()
    await signIn(wizard)

    expect(wizard.get()).toMatchObject({
      step: 'finish',
      view: { kind: 'failed', error: 'Connect GitHub first (no credential stored)' },
    })
  })

  describe('a stale result never changes the wizard', () => {
    it('back to the repo step while the consented connect is in flight', async () => {
      scriptExisting('needsPublicConfirm')
      const wizard = createWizard()
      await signIn(wizard)
      const gate = Promise.withResolvers<ConnectExistingResult>()
      connector.onConnectExistingRepo(() => gate.promise)

      wizard.confirmPublic()
      wizard.backToRepo()
      gate.resolve('connected')
      await flush()
      expect(wizard.get().step).toBe('repo')
      expect(existingCalls().some((call) => call.allowPublic)).toBe(false)
    })

    it('back to the repo step while a poll check is in flight', async () => {
      scriptExisting('notFound')
      const wizard = createWizard()
      await parkOnCreateGuide(wizard)
      const gate = Promise.withResolvers<ConnectExistingResult>()
      connector.onConnectExistingRepo(() => gate.promise)
      await advance(POLL_MS)
      expect(existingCalls()).toHaveLength(2)

      wizard.backToRepo()
      gate.resolve('needsPublicConfirm')
      await flush()
      expect(wizard.get().step).toBe('repo')

      // A new attempt starts clean.
      scriptExisting('connected')
      await signIn(wizard)
      expect(wizard.get().step).toBe('connected')
    })

    it('detach while a check is in flight', async () => {
      const gate = Promise.withResolvers<ConnectExistingResult>()
      connector.onConnectExistingRepo(() => gate.promise)
      const wizard = createWizard()
      await signIn(wizard)

      detach()
      gate.resolve('connected')
      await flush()
      expect(wizard.get()).toMatchObject({ step: 'finish', view: { kind: 'connecting' } })
    })

    it('a sign-in that finishes after detach starts nothing', async () => {
      connector.onConnectNewRepo(() => Promise.resolve('manualCreateNeeded'))
      scriptExisting('notFound')
      const wizard = createWizard()
      wizard.continueFromRepo()

      detach()
      wizard.onAuthed(ALEX)
      await flush()
      expect(wizard.get().step).toBe('auth')
      expect(connector.calls()).toEqual([])
      await advance(POLL_MS * 2)
      expect(connector.calls()).toEqual([])
      expect(clock.pendingTimers()).toBe(0)
    })

    it('the connector gets the flow signal', async () => {
      let signal: AbortSignal | undefined
      connector.onConnectExistingRepo((_ref, options) => {
        signal = options?.signal
        return Promise.resolve('needsPublicConfirm')
      })
      const wizard = createWizard()
      await signIn(wizard)

      expect(signal?.aborted).toBe(false)
      wizard.backToRepo()
      expect(signal?.aborted).toBe(true)
    })
  })
})
