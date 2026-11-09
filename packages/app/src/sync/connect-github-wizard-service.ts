import {
  AppError,
  errorMessage,
  githubAppInstallUrl,
  newRepoUrl,
  parseRepoInput,
  WritableStore,
  type ClockService,
  type GithubAuthService,
  type GithubConnector,
  type GithubRepoRef,
  type GithubUser,
  type Store,
  type Unlisten,
} from '@reflect/core'
import { createDeferred } from '@reflect/utils'
import type { AppLifecycleService } from '../app/lifecycle-service.ts'
import type { OpenerService } from '../app/opener-service.ts'
import { pollUntil } from './poll-until.ts'

/**
 * Which credential the sign-in stored.
 */
export type ConnectAuthKind = 'app' | 'pat' | null

/**
 * The repository the repo step chose: a new one to create under the signed-in
 * user, or an existing one.
 */
export type ConnectRepoChoice =
  | { readonly kind: 'create'; readonly name: string }
  | { readonly kind: 'existing'; readonly ref: GithubRepoRef }

/**
 * What the finish step shows. `publicConfirm` waits for consent to connect a
 * public repo. `createGuide` (the github.com/new handoff) and `grantAccess`
 * (the GitHub App installation handoff) poll until the repo is visible.
 */
export type ConnectFinishView =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'publicConfirm'; readonly repo: GithubRepoRef }
  | {
      readonly kind: 'createGuide'
      readonly repo: GithubRepoRef
      readonly authKind: ConnectAuthKind
    }
  | { readonly kind: 'grantAccess'; readonly repo: GithubRepoRef }
  | { readonly kind: 'failed'; readonly error: string }

/**
 * What a "Connect GitHub" surface renders. The object changes identity on every change.
 */
export type ConnectGithubWizardState =
  | {
      readonly step: 'repo'
      readonly mode: 'create' | 'existing'
      readonly repoName: string
      readonly existingRepo: string
      readonly error: string | null
    }
  | { readonly step: 'auth'; readonly choice: ConnectRepoChoice }
  | {
      readonly step: 'finish'
      readonly user: GithubUser
      readonly view: ConnectFinishView
      /**
       * The URL to visit by hand when the browser could not open it.
       */
      readonly openError: string | null
    }
  | { readonly step: 'connected' }

export type ConnectWizardStep = ConnectGithubWizardState['step']

export interface ConnectGithubWizardOptions {
  /**
   * A suggested name for a newly created backup repo.
   */
  suggestedRepoName: string
  /**
   * Delay between repo-existence polls on the create/grant handoffs (test hook).
   */
  pollIntervalMs?: number | undefined
}

/**
 * The "Connect GitHub" wizard: repository first (creating one needs no
 * credential), then the sign-in (whose instructions can name that exact
 * repository), then the connection, built from the verified sign-in so the
 * owner is never asked for. Desktop's dialog and mobile's drawer drive the
 * same flow through it.
 *
 * The finish step is one async flow. A token that can create repositories
 * connects in one step. Otherwise the user creates the repo on github.com/new
 * while the wizard polls and connects the moment it exists. An app sign-in
 * that cannot see an existing repo needs the app installed on it, so it gets
 * a "grant access" step that polls the same way. A public repo needs explicit
 * consent: every note in the graph, including `private: true` ones, would be
 * world-readable.
 */
export interface ConnectGithubWizardService extends Store<ConnectGithubWizardState> {
  /**
   * Mount the wizard. `onAuthed` is ignored while it is not mounted, and the
   * returned function aborts the running connect.
   */
  readonly attach: () => Unlisten
  readonly setMode: (mode: 'create' | 'existing') => void
  readonly setRepoName: (name: string) => void
  readonly setExistingRepo: (value: string) => void
  /**
   * Validate the repo step and advance to sign-in.
   */
  readonly continueFromRepo: () => void
  /**
   * Call once the sign-in step verified the user: advances and connects.
   */
  readonly onAuthed: (user: GithubUser) => void
  /**
   * The public-repo consent button.
   */
  readonly confirmPublic: () => void
  /**
   * Abort the connect and go back to the repo step.
   */
  readonly backToRepo: () => void
  /**
   * Open the prefilled github.com/new page for the repo the create guide names.
   */
  readonly openCreatePage: () => void
  /**
   * Open the GitHub App installation page (grant repository access).
   */
  readonly openInstallPage: () => void
}

/**
 * The services a {@link ConnectGithubWizardService} runs on.
 */
export interface ConnectGithubWizardDeps {
  readonly connector: Pick<GithubConnector, 'connectNewRepo' | 'connectExistingRepo'>
  readonly githubAuth: GithubAuthService
  readonly opener: OpenerService
  readonly lifecycle: AppLifecycleService
  readonly clock: ClockService
}

interface RepoForm {
  readonly mode: 'create' | 'existing'
  readonly repoName: string
  readonly existingRepo: string
}

class ConnectGithubWizardServiceImpl implements ConnectGithubWizardService {
  readonly #deps: ConnectGithubWizardDeps
  readonly #pollIntervalMs: number
  readonly #state: WritableStore<ConnectGithubWizardState>
  // Kept across steps, so going back to the repo step keeps the input.
  #form: RepoForm
  #attached = 0
  #flow: AbortController | null = null
  #confirmPublic: (() => void) | null = null

  constructor(deps: ConnectGithubWizardDeps, options: ConnectGithubWizardOptions) {
    this.#deps = deps
    this.#pollIntervalMs = options.pollIntervalMs ?? 3000
    this.#form = { mode: 'create', repoName: options.suggestedRepoName, existingRepo: '' }
    this.#state = new WritableStore<ConnectGithubWizardState>({
      step: 'repo',
      ...this.#form,
      error: null,
    })
  }

  readonly get = (): ConnectGithubWizardState => this.#state.get()

  readonly subscribe = (listener: VoidFunction): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    return this.#state.subscribe(() => {
      listener()
    })
  }

  readonly attach = (): Unlisten => {
    this.#attached += 1
    let detached = false
    return () => {
      if (detached) {
        return
      }
      detached = true
      this.#attached -= 1
      if (this.#attached === 0) {
        this.#flow?.abort()
      }
    }
  }

  readonly setMode = (mode: 'create' | 'existing'): void => {
    this.#editForm({ mode })
  }

  readonly setRepoName = (repoName: string): void => {
    this.#editForm({ repoName })
  }

  readonly setExistingRepo = (existingRepo: string): void => {
    this.#editForm({ existingRepo })
  }

  readonly continueFromRepo = (): void => {
    const state = this.#state.get()
    if (state.step !== 'repo') {
      return
    }
    const form = this.#form
    if (form.mode === 'create') {
      const name = form.repoName.trim()
      if (name.length === 0) {
        this.#state.set({ ...state, error: 'Name the repository.' })
        return
      }
      this.#state.set({ step: 'auth', choice: { kind: 'create', name } })
      return
    }
    const ref = parseRepoInput(form.existingRepo)
    if (ref === null) {
      this.#state.set({ ...state, error: 'Enter the repository as owner/name or a GitHub URL.' })
      return
    }
    this.#state.set({ step: 'auth', choice: { kind: 'existing', ref } })
  }

  readonly onAuthed = (user: GithubUser): void => {
    const state = this.#state.get()
    // The sign-in step can finish after the surface closed: nothing may start then.
    if (state.step !== 'auth' || this.#attached === 0) {
      return
    }
    const flow = new AbortController()
    this.#flow = flow
    this.#state.set({ step: 'finish', user, view: { kind: 'connecting' }, openError: null })
    void this.#run(state.choice, user, flow.signal)
  }

  readonly confirmPublic = (): void => {
    const confirm = this.#confirmPublic
    if (confirm !== null) {
      this.#confirmPublic = null
      this.#show({ kind: 'connecting' })
      confirm()
    }
  }

  readonly backToRepo = (): void => {
    this.#flow?.abort()
    this.#confirmPublic = null
    this.#state.set({ step: 'repo', ...this.#form, error: null })
  }

  readonly openCreatePage = (): void => {
    const state = this.#state.get()
    if (state.step === 'finish' && state.view.kind === 'createGuide') {
      void this.#openExternal(newRepoUrl(state.view.repo.name))
    }
  }

  readonly openInstallPage = (): void => {
    void this.#openExternal(githubAppInstallUrl())
  }

  #editForm(patch: Partial<RepoForm>): void {
    const state = this.#state.get()
    if (state.step !== 'repo') {
      return
    }
    this.#form = { ...this.#form, ...patch }
    this.#state.set({ ...state, ...patch })
  }

  #show(view: ConnectFinishView): void {
    const state = this.#state.get()
    if (state.step === 'finish') {
      this.#state.set({ ...state, view, openError: null })
    }
  }

  async #run(choice: ConnectRepoChoice, user: GithubUser, signal: AbortSignal): Promise<void> {
    try {
      await this.#connect(choice, user, signal)
    } catch (caught: unknown) {
      if (!signal.aborted) {
        this.#show({ kind: 'failed', error: errorMessage(caught) })
      }
      return
    }
    if (!signal.aborted) {
      this.#state.set({ step: 'connected' })
    }
  }

  /**
   * Connect `choice`, resolving once connected. Every await settles only while
   * `signal` is live, so an aborted flow never writes state, and the connector
   * gets `signal` so an aborted flow never changes the graph's remote.
   */
  async #connect(choice: ConnectRepoChoice, user: GithubUser, signal: AbortSignal): Promise<void> {
    const { connector, githubAuth, clock, lifecycle } = this.#deps
    const settle = async <T>(promise: Promise<T>): Promise<T> => {
      const value = await promise
      signal.throwIfAborted()
      return value
    }
    const repo = choice.kind === 'create' ? { owner: user.login, name: choice.name } : choice.ref

    let result = await settle(connector.connectExistingRepo(repo, { allowPublic: false, signal }))
    if (result === 'notFound') {
      if (choice.kind === 'create') {
        if ((await settle(connector.connectNewRepo(choice.name, { signal }))) === 'connected') {
          return
        }
        const authKind = (await settle(githubAuth.load()))?.kind ?? null
        this.#show({ kind: 'createGuide', repo, authKind })
      } else {
        // GitHub's 404 means "doesn't exist" or "no access". For an app
        // sign-in it almost always means the app isn't installed on the repo.
        // PAT users reach repos by token scope instead.
        const authKind = (await settle(githubAuth.load()))?.kind ?? null
        if (authKind !== 'app') {
          throw new AppError(
            'auth',
            'Repository not found. Check the name and your token’s repository access.',
          )
        }
        this.#show({ kind: 'grantAccess', repo })
      }
      result = await pollUntil(
        () => connector.connectExistingRepo(repo, { allowPublic: false, signal }),
        (value) => value !== 'notFound',
        { intervalMs: this.#pollIntervalMs, clock, lifecycle, signal },
      )
    }
    if (result === 'needsPublicConfirm') {
      await this.#askConsent(repo, signal)
      signal.throwIfAborted()
      result = await settle(connector.connectExistingRepo(repo, { allowPublic: true, signal }))
    }
    if (result !== 'connected') {
      throw new AppError('notFound', 'Repository not found.')
    }
  }

  /**
   * Show the public-repo consent question. Resolves on `confirmPublic`, rejects on abort.
   */
  #askConsent(repo: GithubRepoRef, signal: AbortSignal): Promise<void> {
    const { promise, resolve, reject } = createDeferred<void>()
    this.#confirmPublic = () => resolve()
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason)
      },
      { once: true },
    )
    this.#show({ kind: 'publicConfirm', repo })
    return promise
  }

  /**
   * Open in the browser; an opener failure surfaces the URL to visit by hand.
   */
  async #openExternal(url: string): Promise<void> {
    const before = this.#state.get()
    try {
      await this.#deps.opener.openUrl(url)
    } catch {
      const state = this.#state.get()
      if (state.step === 'finish' && before.step === 'finish' && state.view === before.view) {
        this.#state.set({
          ...state,
          openError: `Couldn’t open the browser — visit ${url} yourself.`,
        })
      }
    }
  }
}

export function createConnectGithubWizardService(
  deps: ConnectGithubWizardDeps,
  options: ConnectGithubWizardOptions,
): ConnectGithubWizardService {
  return new ConnectGithubWizardServiceImpl(deps, options)
}
