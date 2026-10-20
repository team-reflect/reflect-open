import {
  errorMessage,
  githubAppInstallUrl,
  newRepoUrl,
  parseRepoInput,
  type GitSyncService,
  type ClockService,
  type GithubRepoRef,
  type GithubAuthService,
  type GithubUser,
  type TimerHandle,
  type Unlisten,
} from '@reflect/core'
import type { AppLifecycleService } from '../app/lifecycle-service.ts'
import type { OpenerService } from '../app/opener-service.ts'

export type ConnectWizardStep = 'repo' | 'auth' | 'finish'

/**
 * Which credential the sign-in stored — decides the can't-find-repo remedy.
 */
export type ConnectAuthKind = 'app' | 'pat' | null

/**
 * What the finish step shows — exactly one at a time, precedence encoded
 * here so no shell can order the branches differently. `publicConfirm` is
 * the consent gate for a public repo; `createGuide` is the github.com/new
 * handoff (a poll connects once the repo exists); `grantAccess` is the
 * GitHub-App installation handoff (same poll); `connecting` is the in-flight
 * connect; `idle` is where a failure's inline error (and its escape back to
 * the repo step) renders.
 */
export type ConnectFinishView =
  | { kind: 'publicConfirm'; repo: GithubRepoRef }
  | { kind: 'createGuide'; owner: string; name: string }
  | { kind: 'grantAccess'; repo: GithubRepoRef }
  | { kind: 'connecting' }
  | { kind: 'idle' }

export interface ConnectGithubWizardOptions {
  /**
   * A suggested name for a newly created backup repo.
   */
  suggestedRepoName: string
  /**
   * Called once the repository is connected (the surface dismisses itself).
   */
  onClose: () => void
  /**
   * Delay between repo-existence polls on the create/grant handoffs (test hook).
   */
  pollIntervalMs?: number | undefined
}

/**
 * What a "Connect GitHub" surface renders. The object changes identity on every change.
 */
export interface ConnectGithubWizardState {
  readonly step: ConnectWizardStep
  readonly mode: 'create' | 'existing'
  readonly repoName: string
  readonly existingRepo: string
  /**
   * The verified sign-in shown on the finish step; null before auth.
   */
  readonly user: GithubUser | null
  readonly authKind: ConnectAuthKind
  /**
   * The finish step's current view — shells render it, never re-derive it.
   */
  readonly finishView: ConnectFinishView
  readonly pending: boolean
  readonly error: string | null
}

/**
 * The "Connect GitHub" wizard state machine: repository first (creating one
 * needs no credential), then the sign-in (whose instructions can name that
 * exact repository), then the connection — built from the verified sign-in,
 * so the owner is never asked for. Extracted from rendering so desktop's
 * dialog and mobile's drawer drive the identical flow.
 *
 * Tokens that can create repositories (classic PATs, app tokens) connect in
 * one step: the finish step API-creates silently. Tokens that can't are
 * handed the prefilled github.com/new page while the wizard polls for the
 * repository and connects the moment it exists — there is no "I created it"
 * button to click. Connecting a public repo demands explicit confirmation:
 * every note in the graph, including `private: true` ones, would be
 * world-readable.
 *
 * Granting repository access is a first-class step, not an error. A GitHub App
 * user token only reaches repositories the app is installed on (authorization
 * ≠ installation), and a fresh install is on zero repos — so an app sign-in
 * that can't yet see the repo lands on a plain "grant access" step that polls
 * and connects the moment access is granted (no retry button to press). The
 * step is skipped whenever the repo is already visible, so a graph whose repo
 * the install already covers connects with no detour. PAT users reach repos
 * by token scope, not an installation, so they get token-scope guidance.
 */
export interface ConnectGithubWizardService {
  getState: () => ConnectGithubWizardState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Mount the wizard: the repo-existence poll only runs between this call
   * and the returned function. Detaching cancels future ticks but not one
   * already in flight.
   */
  attach(): Unlisten
  setMode(mode: 'create' | 'existing'): void
  setRepoName(name: string): void
  setExistingRepo(value: string): void
  /**
   * Validate the repo step and advance to sign-in.
   */
  continueFromRepo(): void
  /**
   * Call once the sign-in step verified the user — advances and connects.
   */
  onAuthed(user: GithubUser): void
  /**
   * The public-repo consent button: retry the connect with consent given.
   */
  confirmPublic(): void
  /**
   * Back to the repo step — every finish-step dead end must offer this.
   */
  backToRepo(): void
  /**
   * Open the prefilled github.com/new page for the chosen name.
   */
  openCreatePage(): void
  /**
   * Open the GitHub App installation page (grant repository access).
   */
  openInstallPage(): void
}

/**
 * The services a {@link ConnectGithubWizardService} runs on.
 */
export interface ConnectGithubWizardDeps {
  readonly connect: Pick<GitSyncService, 'connectNewRepo' | 'connectExistingRepo'>
  readonly githubAuth: GithubAuthService
  readonly opener: OpenerService
  readonly lifecycle: AppLifecycleService
  readonly clock: ClockService
}

/**
 * The fields the wizard stores; the rest of its state derives from them.
 */
interface WizardFields {
  step: ConnectWizardStep
  mode: 'create' | 'existing'
  repoName: string
  existingRepo: string
  user: GithubUser | null
  authKind: ConnectAuthKind
  publicConfirm: GithubRepoRef | null
  showCreateGuide: boolean
  showGrantAccess: boolean
  pending: boolean
  error: string | null
}

class ConnectGithubWizardServiceImpl implements ConnectGithubWizardService {
  readonly #deps: ConnectGithubWizardDeps
  readonly #options: ConnectGithubWizardOptions
  readonly #pollIntervalMs: number
  readonly #listeners = new Set<() => void>()
  #fields: WizardFields
  #state: ConnectGithubWizardState
  #attached = 0
  #stopPoll: (() => void) | null = null

  constructor(deps: ConnectGithubWizardDeps, options: ConnectGithubWizardOptions) {
    this.#deps = deps
    this.#options = options
    this.#pollIntervalMs = options.pollIntervalMs ?? 3000
    this.#fields = {
      step: 'repo',
      mode: 'create',
      repoName: options.suggestedRepoName,
      existingRepo: '',
      user: null,
      authKind: null,
      publicConfirm: null,
      showCreateGuide: false,
      showGrantAccess: false,
      pending: false,
      error: null,
    }
    this.#state = this.#derive()
  }

  readonly getState = (): ConnectGithubWizardState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  attach(): Unlisten {
    this.#attached += 1
    this.#syncPoll()
    let detached = false
    return () => {
      if (detached) {
        return
      }
      detached = true
      this.#attached -= 1
      this.#syncPoll()
    }
  }

  setMode(mode: 'create' | 'existing'): void {
    this.#patch({ mode })
  }

  setRepoName(repoName: string): void {
    this.#patch({ repoName })
  }

  setExistingRepo(existingRepo: string): void {
    this.#patch({ existingRepo })
  }

  continueFromRepo(): void {
    const fields = this.#fields
    if (fields.mode === 'create' && fields.repoName.trim().length === 0) {
      this.#patch({ error: 'Name the repository.' })
      return
    }
    if (fields.mode === 'existing' && parseRepoInput(fields.existingRepo) === null) {
      this.#patch({ error: 'Enter the repository as owner/name or a GitHub URL.' })
      return
    }
    this.#patch({ error: null, step: 'auth' })
  }

  onAuthed(authedUser: GithubUser): void {
    this.#patch({ user: authedUser, step: 'finish' })
    void this.#deps.githubAuth.load().then((auth) => {
      const kind = auth?.kind ?? null
      this.#patch({ authKind: kind })
      return this.#finish(authedUser, { kind })
    })
  }

  confirmPublic(): void {
    if (this.#fields.user !== null) {
      void this.#finish(this.#fields.user, { allowPublic: true })
    }
  }

  backToRepo(): void {
    this.#patch({
      error: null,
      publicConfirm: null,
      showCreateGuide: false,
      showGrantAccess: false,
      step: 'repo',
    })
  }

  openCreatePage(): void {
    this.#openExternal(newRepoUrl(this.#fields.repoName.trim()))
  }

  openInstallPage(): void {
    this.#openExternal(githubAppInstallUrl())
  }

  #targetRef(forUser: GithubUser): GithubRepoRef | null {
    const fields = this.#fields
    if (fields.mode === 'existing') {
      return parseRepoInput(fields.existingRepo)
    }
    const name = fields.repoName.trim()
    return name.length === 0 ? null : { owner: forUser.login, name }
  }

  // The repo we're trying to reach, resolved from the verified sign-in (the
  // owner is never typed). Drives both the poll and the grant-access copy.
  #targetForUser(): GithubRepoRef | null {
    return this.#fields.user !== null ? this.#targetRef(this.#fields.user) : null
  }

  // While the create handoff or the grant-access step is showing, poll for the
  // repository instead of making the user click a button: the connect fires the
  // moment the repo exists and the app can see it. A 404 just keeps waiting; a
  // public repo stops the poll for consent.
  #pollTarget(): GithubRepoRef | null {
    const fields = this.#fields
    return (fields.showCreateGuide || fields.showGrantAccess) && fields.publicConfirm === null
      ? this.#targetForUser()
      : null
  }

  #derive(): ConnectGithubWizardState {
    const fields = this.#fields
    const target = this.#targetForUser()
    // The parked handoffs outrank the transient states: a consent question or
    // an open poll must never be painted over by "Connecting…".
    const finishView: ConnectFinishView =
      fields.publicConfirm !== null
        ? { kind: 'publicConfirm', repo: fields.publicConfirm }
        : fields.showCreateGuide && fields.user !== null
          ? { kind: 'createGuide', owner: fields.user.login, name: fields.repoName.trim() }
          : fields.showGrantAccess && target !== null
            ? { kind: 'grantAccess', repo: target }
            : fields.pending
              ? { kind: 'connecting' }
              : { kind: 'idle' }
    return {
      step: fields.step,
      mode: fields.mode,
      repoName: fields.repoName,
      existingRepo: fields.existingRepo,
      user: fields.user,
      authKind: fields.authKind,
      finishView,
      pending: fields.pending,
      error: fields.error,
    }
  }

  async #tick(): Promise<'continue' | 'stop'> {
    const target = this.#pollTarget()
    if (target === null) {
      return 'stop'
    }
    const result = await this.#deps.connect.connectExistingRepo(target, { allowPublic: false })
    if (result === 'connected') {
      this.#options.onClose()
      return 'stop'
    }
    if (result === 'needsPublicConfirm') {
      this.#patch({ publicConfirm: target })
      return 'stop'
    }
    return 'continue'
  }

  /**
   * Run the poll tick every `pollIntervalMs`, starting one interval from now
   * (the caller typically just ran the same check inline). Ticks never
   * overlap — the next wait starts when the previous tick settles — and a tick
   * that throws keeps the loop alive: the network check fails transiently.
   * A tick's 'stop' ends the loop. The returned function cancels future ticks
   * but not one already in flight.
   *
   * Polling pauses while the document is hidden — a hidden poll can't show its
   * result, and the user left the app to do something (create a repo, grant
   * access) — and resumes with an *immediate* tick on return to visible: the
   * moment the user comes back is exactly when the polled condition is
   * likeliest to have just become true.
   */
  #startPoll(): () => void {
    const { lifecycle, clock } = this.#deps
    let cancelled = false
    let stopped = false
    let inFlight = false
    let timer: TimerHandle | null = null

    const settle = (result: 'continue' | 'stop'): void => {
      inFlight = false
      if (cancelled) {
        return
      }
      if (result === 'stop') {
        stopped = true
        return
      }
      schedule()
    }

    const runTick = (): void => {
      inFlight = true
      try {
        void this.#tick().then(settle, () => settle('continue'))
      } catch {
        // A synchronous throw must not strand `inFlight` — that would block
        // the visibility resume forever. Same rule as a rejection.
        settle('continue')
      }
    }

    const schedule = (): void => {
      if (lifecycle.isHidden()) {
        return // paused — the visibility listener resumes with an immediate tick
      }
      timer = clock.setTimeout(() => {
        timer = null
        if (lifecycle.isHidden()) {
          return // went hidden in the firing gap; the listener resumes us
        }
        runTick()
      }, this.#pollIntervalMs)
    }

    const removeHidden = lifecycle.subscribeHidden(() => {
      if (timer !== null) {
        clock.clearTimeout(timer)
        timer = null
      }
    })
    const removeVisible = lifecycle.subscribeVisible(() => {
      // An in-flight tick reschedules itself when it settles, and a pending
      // timer means the loop never paused — only a paused loop resumes here.
      if (!stopped && !inFlight && timer === null) {
        runTick()
      }
    })
    schedule()
    return () => {
      cancelled = true
      if (timer !== null) {
        clock.clearTimeout(timer)
      }
      removeHidden()
      removeVisible()
    }
  }

  /**
   * Start or cancel the poll to match the mounted state and the poll target.
   */
  #syncPoll(): void {
    const enabled = this.#attached > 0 && this.#pollTarget() !== null
    if (enabled && this.#stopPoll === null) {
      this.#stopPoll = this.#startPoll()
    } else if (!enabled && this.#stopPoll !== null) {
      this.#stopPoll()
      this.#stopPoll = null
    }
  }

  #patch(next: Partial<WizardFields>): void {
    this.#fields = { ...this.#fields, ...next }
    this.#state = this.#derive()
    this.#syncPoll()
    for (const listener of this.#listeners) {
      listener()
    }
  }

  /**
   * Run one async action: clears the previous error, flips `pending` for the
   * duration, and captures a failure as a display message.
   */
  async #run(action: () => Promise<void>): Promise<void> {
    this.#patch({ error: null, pending: true })
    try {
      await action()
    } catch (caught: unknown) {
      this.#patch({ error: errorMessage(caught), pending: false })
      return
    }
    this.#patch({ pending: false })
  }

  async #finish(
    forUser: GithubUser,
    finishOptions: { allowPublic?: boolean; kind?: ConnectAuthKind } = {},
  ): Promise<void> {
    const { connect } = this.#deps
    // The choices this attempt was started with: a change made while it is in
    // flight belongs to the next attempt.
    const kind = finishOptions.kind ?? this.#fields.authKind
    const mode = this.#fields.mode
    const ref = this.#fields.publicConfirm ?? this.#targetRef(forUser)
    await this.#run(async () => {
      // Each attempt re-derives the guidance from its own outcome — a stale
      // create guide or grant-access step from an earlier path must not outlive
      // the detour (e.g. consent → choose another repo).
      if (ref === null) {
        this.#patch({
          showCreateGuide: false,
          showGrantAccess: false,
          error:
            mode === 'existing'
              ? 'Enter the repository as owner/name or a GitHub URL.'
              : 'Name the repository.',
          step: 'repo',
        })
        return
      }
      this.#patch({ showCreateGuide: false, showGrantAccess: false })
      const result = await connect.connectExistingRepo(ref, {
        allowPublic: finishOptions.allowPublic ?? false,
      })
      if (result === 'connected') {
        this.#options.onClose()
        return
      }
      if (result === 'needsPublicConfirm') {
        this.#patch({ publicConfirm: ref })
        return
      }
      if (mode === 'existing') {
        // GitHub's 404 can't distinguish "doesn't exist" from "no access". App
        // sign-ins almost always mean the latter — the app isn't installed on
        // the repo yet — so granting access is the expected next step, not an
        // error: show it plainly and let the poll connect the moment access
        // lands. PAT users reach repos by token scope, not an installation, so
        // they get token-scope guidance instead.
        if (kind === 'app') {
          this.#patch({ showGrantAccess: true })
        } else {
          this.#patch({
            error: 'Repository not found. Check the name and your token’s repository access.',
          })
        }
        return
      }
      // A new repo that doesn't exist yet: create it — by API when the token
      // can, by the guided handoff (plus polling) otherwise.
      const created = await connect.connectNewRepo(ref.name)
      if (created === 'connected') {
        this.#options.onClose()
        return
      }
      this.#patch({ showCreateGuide: true })
    })
  }

  /**
   * Open in the browser; an opener failure surfaces the URL to visit by hand.
   */
  #openExternal(url: string): void {
    void this.#deps.opener.openUrl(url).catch(() => {
      this.#patch({ error: `Couldn’t open the browser — visit ${url} yourself.` })
    })
  }
}

export function createConnectGithubWizardService(
  deps: ConnectGithubWizardDeps,
  options: ConnectGithubWizardOptions,
): ConnectGithubWizardService {
  return new ConnectGithubWizardServiceImpl(deps, options)
}
