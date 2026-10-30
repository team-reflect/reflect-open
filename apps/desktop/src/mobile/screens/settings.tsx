import { useId, useState, type ReactElement, type ReactNode } from 'react'
import { getMobileSyncStatus, remoteLabel, type MobileSyncDetail } from '@reflect/app'
import { useQuery } from '@tanstack/react-query'
import {
  aiProvider,
  aiProviderRequiresApiKey,
  errorMessage,
  marketingVersion,
  CHAT_SYSTEM_PROMPT_MAX_LENGTH,
  TRANSCRIPTION_PROMPT_MAX_LENGTH,
  normalizeChatSystemPrompt,
  normalizeTranscriptionPrompt,
  type AiPrompt,
  type AiProviderConfig,
  type DateFormat,
  type EditorTextSize,
  type ThemePreference,
  type TimeFormat,
  type WeekStartDay,
} from '@reflect/core'
import { useAiPrompts } from '@/hooks/use-ai-prompts.ts'
import { useAiProviders } from '@/hooks/use-ai-providers.ts'
import { useGithubConnected } from '@/hooks/use-github-connected.ts'
import { useAppVersion } from '@/hooks/use-app-version.ts'
import { useCrashTest, useDebugUnlockTap } from '@/hooks/use-debug-unlock.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { AddAiProviderDrawer } from '@/mobile/add-ai-provider-drawer.tsx'
import { AiPromptDrawer } from '@/mobile/ai-prompt-drawer.tsx'
import { AiProviderActionsDrawer } from '@/mobile/ai-provider-actions-drawer.tsx'
import { ConnectGithubDrawer } from '@/mobile/connect-github-drawer.tsx'
import { ConnectGitHostDrawer } from '@/mobile/connect-git-host-drawer.tsx'
import { ConnectRepositoryDrawer } from '@/mobile/connect-repository-drawer.tsx'
import { GithubSignInDrawer } from '@/mobile/github-sign-in-drawer.tsx'
import { PRIVACY_POLICY_URL } from '@/mobile/legal-urls.ts'
import { MobileScreenHeader } from '@/mobile/screen-header.tsx'
import { TextSettingDrawer } from '@/mobile/text-setting-drawer.tsx'
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsNavRow,
  SettingsSegmentedRow,
  SettingsSelectRow,
  SettingsSwitchRow,
  SettingsValueRow,
  type SegmentedOption,
} from '@/mobile/settings-list.tsx'
import { useAppStoreEnvironment } from '@/mobile/use-app-store-environment.ts'
import { useSubscriptionControls } from '@/mobile/use-subscription-controls.ts'
import { setPerfHudEnabled, usePerfHudEnabled } from '@/perf-hud/flag.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { formatFullDate } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { CountdownText } from '@/components/countdown-text.tsx'
import { useGitSyncContext } from '@/providers/sync-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

const THEME_OPTIONS: readonly SegmentedOption<ThemePreference>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function aiProviderValue(provider: AiProviderConfig, defaultProviderId: string | null): string {
  const credential =
    aiProviderRequiresApiKey(provider.provider) || provider.keyHint !== ''
      ? `·····${provider.keyHint}`
      : 'No API key'
  return provider.id === defaultProviderId ? `${credential} · Default` : credential
}

const TEXT_SIZE_OPTIONS: readonly SegmentedOption<EditorTextSize>[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

const DATE_FORMATS: readonly DateFormat[] = ['mdy', 'dmy', 'iso']

const WEEK_START_OPTIONS: readonly SegmentedOption<WeekStartDay>[] = [
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
  { value: 'saturday', label: 'Saturday' },
]

const TIME_FORMAT_OPTIONS: readonly SegmentedOption<TimeFormat>[] = [
  { value: '12h', label: '12-hour' },
  { value: '24h', label: '24-hour' },
]

function SyncDetail({ detail }: { detail: MobileSyncDetail }): ReactNode {
  if (detail.kind === 'message') {
    return detail.text
  }
  return (
    <>
      Syncs in <CountdownText until={detail.until} />
    </>
  )
}

/**
 * The mobile Settings screen — a pushed card (route kind `settings`) in the
 * iOS inset-grouped idiom, replacing the old bottom-sheet hodgepodge. The
 * graph row discloses into the Graphs switcher screen; appearance and editor
 * preferences edit the shared settings document (the same keys desktop
 * exposes); the Git repository group mirrors the status pill's engine state,
 * connects a repository for the local graph through one door (the
 * {@link ConnectRepositoryDrawer} choice, then the {@link ConnectGithubDrawer}
 * or {@link ConnectGitHostDrawer} sheet — iCloud graphs sync through the
 * container instead, Plan 21), and can stop. The Accounts group is the
 * device's GitHub sign-in, independent of the graph.
 */
export function MobileSettings(): ReactElement {
  const { back, canBack, navigate } = useRouter()
  const { graph, mobileStorageKind, platform } = useGraph()
  const isIos = platform === 'ios'
  const subscriptionControls = useSubscriptionControls()
  const { opener } = useAppServices()
  const { githubAuth, platform: platformService, noteList, logger } = useCoreServices()
  const { settings, updateSettings } = useSettings()
  const [today] = useState(() => new Date())
  const version = useAppVersion()
  const { unlocked: debugUnlocked, tap: versionTap } = useDebugUnlockTap()
  const crashTest = useCrashTest()
  const perfHudEnabled = usePerfHudEnabled()
  const environment = useAppStoreEnvironment()
  // Development and TestFlight installs show the prerelease tag; anything else hides it.
  const showPrerelease =
    platformService.isDev || environment.value === 'Sandbox' || environment.value === 'Xcode'
  const versionLabel = version === null ? '…' : showPrerelease ? version : marketingVersion(version)
  const sync = useGitSyncContext()
  const githubConnected = useGithubConnected()
  const [disconnecting, setDisconnecting] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [signInOpen, setSignInOpen] = useState(false)
  // Which connect sheet is open: the host choice, or one host's own flow.
  // `remoteUrl` prefills the host form for a remote that is already set.
  const [sheet, setSheet] = useState<
    { kind: 'choose' } | { kind: 'github' } | { kind: 'host'; remoteUrl?: string } | null
  >(null)
  const { providers, defaultProvider, addProvider, removeProvider, makeDefault, setDefaultModel } =
    useAiProviders()
  const [addProviderOpen, setAddProviderOpen] = useState(false)
  const [systemPromptOpen, setSystemPromptOpen] = useState(false)
  const [transcriptionPromptOpen, setTranscriptionPromptOpen] = useState(false)
  const { prompts, addPrompt, updatePrompt, removePrompt } = useAiPrompts()
  // The edited prompt sticks around after close so the exit animation has
  // content; `promptOpen` alone drives visibility (the edit-sheet pattern).
  const [editingPrompt, setEditingPrompt] = useState<AiPrompt | 'new' | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const audioMemoDescriptionId = useId()
  // The managed provider sticks around after close so the exit animation has
  // content; `manageOpen` alone drives visibility (the edit-sheet pattern).
  const [managedProvider, setManagedProvider] = useState<AiProviderConfig | null>(null)
  const [manageOpen, setManageOpen] = useState(false)

  const { data: notes } = useQuery({
    queryKey: queryKeys.index.mobileNoteCount(graph?.root),
    queryFn: () => noteList.listNotes(),
    enabled: graph !== null,
  })

  const gitSync = sync?.state ?? null
  const status = getMobileSyncStatus(gitSync)
  // A graph with a remote, connected or waiting for its sign-in.
  const remote =
    gitSync !== null && (gitSync.phase === 'connected' || gitSync.phase === 'needsCredential')
      ? gitSync
      : null
  // A host remote that waits for its sign-in can get one here. Plain HTTP
  // cannot: the resolver never sends a sign-in in the clear.
  const canAddSignIn =
    remote?.phase === 'needsCredential' &&
    remote.remote.kind === 'https' &&
    !remote.remote.origin.startsWith('http:')
  // A host remote whose sign-in the host refused gets a new one here.
  const canUpdateSignIn =
    remote?.phase === 'connected' &&
    remote.remote.kind === 'https' &&
    remote.status.state === 'error' &&
    remote.status.errorKind === 'auth'
  // The connect entry points are local-graph-only (iCloud sync and a Git remote
  // are mutually exclusive per graph, Plan 21) and wait out the controller's
  // `loading` phase so the rows never flash on a graph that turns out to be
  // connected.
  const canConnect = mobileStorageKind === 'local' && gitSync?.phase === 'disconnected'

  // Stop syncing this graph: drop its remote. The local clone and every
  // sign-in stay; the controller restarts into its disconnected state.
  async function disconnect(): Promise<void> {
    if (sync === null) {
      return
    }
    setDisconnecting(true)
    try {
      await sync.disconnectGraph()
    } catch (err) {
      logger.error('stop syncing failed:', errorMessage(err))
    } finally {
      setDisconnecting(false)
    }
  }

  // Forget the GitHub sign-in of this device; every GitHub repository stops
  // syncing until the next sign-in.
  async function signOut(): Promise<void> {
    setSigningOut(true)
    setSignOutError(null)
    try {
      await githubAuth.clear()
    } catch (err) {
      setSignOutError(errorMessage(err))
      logger.error('GitHub sign-out failed:', errorMessage(err))
    } finally {
      setSigningOut(false)
    }
  }

  const storageLabel =
    mobileStorageKind === 'icloud'
      ? 'iCloud Drive'
      : mobileStorageKind === 'local'
        ? 'This device'
        : undefined

  return (
    <div className="flex h-full w-screen flex-col pt-safe">
      <MobileScreenHeader
        title="Settings"
        onBack={() => (canBack ? back() : navigate({ kind: 'today' }))}
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-safe pb-safe">
        <div className="flex flex-col gap-6 px-4 py-4">
          <SettingsGroup header="Graph">
            <SettingsNavRow
              label={graph?.name ?? '—'}
              value={storageLabel}
              onPress={() => navigate({ kind: 'graphs' })}
            />
          </SettingsGroup>

          <SettingsGroup header="Appearance">
            <SettingsSegmentedRow
              label="Theme"
              value={settings.theme}
              options={THEME_OPTIONS}
              onChange={(theme) => updateSettings({ theme })}
            />
            <SettingsSegmentedRow
              label="Text size"
              value={settings.editorTextSize}
              options={TEXT_SIZE_OPTIONS}
              onChange={(editorTextSize) => updateSettings({ editorTextSize })}
            />
          </SettingsGroup>

          <SettingsGroup
            header="Date format"
            footer="The style for dates shown throughout Reflect, including daily note titles."
          >
            {DATE_FORMATS.map((dateFormat) => (
              <SettingsSelectRow
                key={dateFormat}
                label={formatFullDate(today, dateFormat)}
                selected={settings.dateFormat === dateFormat}
                onPress={() => updateSettings({ dateFormat })}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup header="Week and time">
            <SettingsSegmentedRow
              label="Week start"
              value={settings.weekStartDay}
              options={WEEK_START_OPTIONS}
              onChange={(weekStartDay) => updateSettings({ weekStartDay })}
            />
            <SettingsSegmentedRow
              label="Time format"
              value={settings.timeFormat}
              options={TIME_FORMAT_OPTIONS}
              onChange={(timeFormat) => updateSettings({ timeFormat })}
            />
          </SettingsGroup>

          <SettingsGroup header="Editor">
            <SettingsSwitchRow
              label="Smooth caret animation"
              checked={settings.editorSmoothCaretAnimation}
              onCheckedChange={(editorSmoothCaretAnimation) => {
                updateSettings({ editorSmoothCaretAnimation })
              }}
            />
            <SettingsSwitchRow
              label="Start with a bullet"
              checked={settings.editorDefaultBullet}
              onCheckedChange={(editorDefaultBullet) => updateSettings({ editorDefaultBullet })}
            />
            <SettingsSwitchRow
              label="Bullet after a heading"
              checked={settings.editorBulletAfterHeading}
              onCheckedChange={(editorBulletAfterHeading) => {
                updateSettings({ editorBulletAfterHeading })
              }}
            />
          </SettingsGroup>

          <SettingsGroup
            header="AI"
            footer="Keys stay in this device’s keychain and are never synced."
          >
            {providers.map((provider) => (
              <SettingsNavRow
                key={provider.id}
                label={aiProvider(provider.provider).label}
                value={aiProviderValue(provider, defaultProvider?.id ?? null)}
                onPress={() => {
                  setManagedProvider(provider)
                  setManageOpen(true)
                }}
              />
            ))}
            <SettingsActionRow label="Add AI provider" onPress={() => setAddProviderOpen(true)} />
            <SettingsNavRow
              label="System prompt"
              value={
                normalizeChatSystemPrompt(settings.chatSystemPrompt) === '' ? 'Default' : 'Custom'
              }
              onPress={() => setSystemPromptOpen(true)}
            />
          </SettingsGroup>

          <SettingsGroup
            header="AI prompts"
            footer="Prompts run on text you select in a note, after the built-in set. They stay on this device and aren’t synced."
          >
            {prompts.map((prompt) => (
              <SettingsNavRow
                key={prompt.id}
                label={prompt.label}
                onPress={() => {
                  setEditingPrompt(prompt)
                  setPromptOpen(true)
                }}
              />
            ))}
            <SettingsActionRow
              label="Add prompt"
              onPress={() => {
                setEditingPrompt('new')
                setPromptOpen(true)
              }}
            />
          </SettingsGroup>

          <SettingsGroup
            header="Audio memos"
            footer="Uses AI to add punctuation, paragraphs, and light Markdown. Helper text is sent to your transcription provider with every memo."
            footerId={audioMemoDescriptionId}
          >
            <SettingsSwitchRow
              label="Transcription auto-format"
              checked={settings.transcriptionFormat}
              descriptionId={audioMemoDescriptionId}
              onCheckedChange={(transcriptionFormat) => updateSettings({ transcriptionFormat })}
            />
            <SettingsNavRow
              label="Helper text"
              value={
                normalizeTranscriptionPrompt(settings.transcriptionPrompt) === ''
                  ? 'None'
                  : 'Custom'
              }
              onPress={() => setTranscriptionPromptOpen(true)}
            />
          </SettingsGroup>

          {remote !== null || canConnect ? (
            <SettingsGroup
              header="Git repository"
              footer={
                canConnect ? (
                  'Sync notes with Reflect on your other devices.'
                ) : status === null || status.detail === null ? null : (
                  <SyncDetail detail={status.detail} />
                )
              }
            >
              {remote !== null ? (
                <SettingsValueRow
                  label="Remote"
                  value={remoteLabel(remote.remote, remote.remoteUrl)}
                />
              ) : null}
              {status !== null ? <SettingsValueRow label="Status" value={status.label} /> : null}
              {canAddSignIn ? (
                <SettingsActionRow
                  label="Add sign-in"
                  onPress={() => setSheet({ kind: 'host', remoteUrl: remote.remoteUrl })}
                />
              ) : null}
              {canUpdateSignIn ? (
                <SettingsActionRow
                  label="Update sign-in"
                  onPress={() => setSheet({ kind: 'host', remoteUrl: remote.remoteUrl })}
                />
              ) : null}
              {canConnect ? (
                <SettingsActionRow
                  label="Connect a repository"
                  onPress={() => setSheet({ kind: 'choose' })}
                />
              ) : null}
              {remote !== null ? (
                <SettingsActionRow
                  label="Stop syncing"
                  tone="destructive"
                  pending={disconnecting}
                  onPress={() => void disconnect()}
                />
              ) : null}
            </SettingsGroup>
          ) : null}

          <SettingsGroup
            header="Accounts"
            footer={
              signOutError ??
              'GitHub is used for GitHub repositories and for sharing notes as gists.'
            }
          >
            {githubConnected ? (
              <SettingsActionRow
                label="Sign out of GitHub"
                tone="destructive"
                pending={signingOut}
                onPress={() => void signOut()}
              />
            ) : (
              <SettingsActionRow label="Sign in to GitHub" onPress={() => setSignInOpen(true)} />
            )}
          </SettingsGroup>

          {isIos ? (
            <SettingsGroup header="Subscription" footer={subscriptionControls.message}>
              <SettingsValueRow label="Plan" value={subscriptionControls.planLabel} />
              {subscriptionControls.canSubscribe ? (
                <SettingsActionRow label="Subscribe" onPress={subscriptionControls.subscribe} />
              ) : subscriptionControls.canManage ? (
                <SettingsActionRow
                  label="Manage Subscription"
                  onPress={subscriptionControls.manage}
                />
              ) : null}
              {subscriptionControls.classicAccount !== null ? (
                <>
                  <SettingsValueRow
                    label="Verified Account"
                    value={subscriptionControls.classicAccount}
                  />
                  <SettingsActionRow
                    label="Remove Reflect Classic Verification"
                    tone="destructive"
                    pending={subscriptionControls.removeClassicVerificationPending}
                    onPress={subscriptionControls.removeClassicVerification}
                  />
                </>
              ) : null}
              <SettingsActionRow
                label="Redeem Code"
                pending={subscriptionControls.redeemPending}
                onPress={() => {
                  void subscriptionControls.redeem()
                }}
              />
              <SettingsActionRow
                label="Restore Purchases"
                pending={subscriptionControls.restorePending}
                onPress={() => {
                  void subscriptionControls.restore()
                }}
              />
              <SettingsActionRow label="Terms of Use" onPress={subscriptionControls.openTerms} />
            </SettingsGroup>
          ) : null}

          <SettingsGroup header="About">
            <SettingsValueRow
              label="Notes"
              value={notes === undefined ? '…' : String(notes.length)}
            />
            <SettingsValueRow label="Version" value={versionLabel} onPress={versionTap} />
            <SettingsNavRow
              label="Open Source Licenses"
              onPress={() => navigate({ kind: 'licenses' })}
            />
            <SettingsActionRow
              label="Privacy Policy"
              onPress={() => {
                opener.openUrlSync(PRIVACY_POLICY_URL)
              }}
            />
          </SettingsGroup>

          {debugUnlocked ? (
            <SettingsGroup
              header="Debug"
              footer="Production is an App Store install; Sandbox is TestFlight or a development install."
            >
              {isIos ? (
                <SettingsValueRow
                  label="Environment"
                  value={environment.value ?? (environment.isError ? 'Unknown' : 'Loading…')}
                />
              ) : null}
              <SettingsSwitchRow
                label="Performance HUD"
                checked={perfHudEnabled}
                onCheckedChange={setPerfHudEnabled}
              />
              <SettingsActionRow
                label="Trigger test error"
                tone="destructive"
                onPress={crashTest}
              />
            </SettingsGroup>
          ) : null}
        </div>
      </main>
      <ConnectRepositoryDrawer
        open={sheet?.kind === 'choose'}
        onOpenChange={(open) => {
          if (!open) {
            setSheet(null)
          }
        }}
        onChoose={(host) => setSheet(host === 'github' ? { kind: 'github' } : { kind: 'host' })}
      />
      <ConnectGithubDrawer
        open={sheet?.kind === 'github'}
        onOpenChange={(open) => {
          if (!open) {
            setSheet(null)
          }
        }}
      />
      <ConnectGitHostDrawer
        open={sheet?.kind === 'host'}
        onOpenChange={(open) => {
          if (!open) {
            setSheet(null)
          }
        }}
        remoteUrl={sheet?.kind === 'host' ? sheet.remoteUrl : undefined}
      />
      <GithubSignInDrawer open={signInOpen} onOpenChange={setSignInOpen} />
      <AddAiProviderDrawer
        open={addProviderOpen}
        onOpenChange={setAddProviderOpen}
        onAdd={addProvider}
      />
      <AiProviderActionsDrawer
        provider={managedProvider}
        isDefault={managedProvider !== null && managedProvider.id === defaultProvider?.id}
        open={manageOpen}
        onOpenChange={setManageOpen}
        onMakeDefault={makeDefault}
        onSetDefaultModel={setDefaultModel}
        onRemove={removeProvider}
      />
      <TextSettingDrawer
        title="System prompt"
        description="Additional instructions sent with every AI chat. Reflect’s note-search, citation, and privacy rules still apply."
        ariaLabel="System prompt instructions"
        placeholder="Be concise. Challenge my assumptions and ask clarifying questions."
        maxLength={CHAT_SYSTEM_PROMPT_MAX_LENGTH}
        rows={8}
        normalize={normalizeChatSystemPrompt}
        value={settings.chatSystemPrompt}
        open={systemPromptOpen}
        onOpenChange={setSystemPromptOpen}
        onSave={(chatSystemPrompt) => updateSettings({ chatSystemPrompt })}
      />
      <TextSettingDrawer
        title="Transcription helper text"
        description="Context sent to your transcription provider with every audio memo, such as names it tends to misspell."
        ariaLabel="Transcription helper text"
        placeholder="This transcription mentions the following names:"
        maxLength={TRANSCRIPTION_PROMPT_MAX_LENGTH}
        rows={3}
        normalize={normalizeTranscriptionPrompt}
        value={settings.transcriptionPrompt}
        open={transcriptionPromptOpen}
        onOpenChange={setTranscriptionPromptOpen}
        onSave={(transcriptionPrompt) => updateSettings({ transcriptionPrompt })}
      />
      <AiPromptDrawer
        prompt={editingPrompt}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        onSave={(draft) => {
          if (editingPrompt === 'new') {
            addPrompt(draft)
          } else if (editingPrompt !== null) {
            updatePrompt(editingPrompt.id, draft)
          }
        }}
        onRemove={removePrompt}
      />
    </div>
  )
}
