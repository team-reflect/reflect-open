import type { ReactElement } from 'react'
import { useAppVersion } from '@/hooks/use-app-version'
import { SettingsSection } from './section'

export function AboutSection(): ReactElement {
  const version = useAppVersion()
  return (
    <SettingsSection title="About">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-[color:var(--text)]">Reflect Open</div>
          <p className="mt-0.5 text-xs text-[color:var(--text-muted)]">
            Local-first networked notes. Your graph is a folder of markdown files.
          </p>
        </div>
        <span className="shrink-0 text-sm text-[color:var(--text-secondary)]">
          {version !== null ? `v${version}` : '—'}
        </span>
      </div>
    </SettingsSection>
  )
}
