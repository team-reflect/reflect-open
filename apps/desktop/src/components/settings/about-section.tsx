import type { ReactElement } from 'react'
import { ArrowDownToLine, RefreshCw, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppVersion } from '@/hooks/use-app-version'
import { useUpdate } from '@/providers/update-provider'
import { SettingsField } from './field'
import { SettingsSection } from './section'

/**
 * The manual path to the same updater the app checks on launch: one button
 * whose label tracks the update lifecycle, with the outcome reported inline.
 */
function UpdateField(): ReactElement {
  const { state, checkNow, install, restart } = useUpdate()

  const action: {
    label: string
    icon: typeof RefreshCw
    run?: () => Promise<void>
    spinning?: boolean
  } = (() => {
    switch (state.phase) {
      case 'checking':
        return { label: 'Checking…', icon: RefreshCw, run: undefined, spinning: true }
      case 'available':
        return { label: `Install ${state.version}`, icon: ArrowDownToLine, run: install }
      case 'downloading':
        return {
          label: `Downloading${state.percent !== null ? ` ${state.percent}%` : '…'}`,
          icon: ArrowDownToLine,
          run: undefined,
        }
      case 'ready':
        return { label: 'Restart to update', icon: RotateCw, run: restart }
      default:
        return { label: 'Check for updates', icon: RefreshCw, run: checkNow }
    }
  })()

  const run = action.run
  return (
    <SettingsField
      legend="Updates"
      description="Reflect checks for new versions on launch and installs them only when you say so."
    >
      <div className="mt-3 flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={run === undefined}
          onClick={run ? () => void run() : undefined}
          className="text-text-secondary"
        >
          <action.icon
            aria-hidden
            strokeWidth={1.75}
            className={action.spinning ? 'animate-spin' : undefined}
          />
          {action.label}
        </Button>
        {state.phase === 'upToDate' ? (
          <span role="status" className="text-xs text-text-muted">
            You're up to date.
          </span>
        ) : null}
        {state.phase === 'error' ? (
          <span role="alert" className="text-xs text-red-500">
            {state.message}
          </span>
        ) : null}
      </div>
    </SettingsField>
  )
}

export function AboutSection(): ReactElement {
  const version = useAppVersion()
  const { supported } = useUpdate()
  return (
    <SettingsSection id="about">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">Reflect Open</div>
          <p className="mt-0.5 text-xs text-text-muted">
            Local-first networked notes. Your graph is a folder of markdown files.
          </p>
        </div>
        <span className="shrink-0 text-sm text-text-secondary">
          {version !== null ? `v${version}` : '—'}
        </span>
      </div>
      {supported ? <UpdateField /> : null}
    </SettingsSection>
  )
}
