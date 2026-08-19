import type { ReactElement } from 'react'
import { useAppVersion } from '@/hooks/use-app-version'
import { useCrashTestTap } from '@/hooks/use-crash-test-tap'
import { useUpdate } from '@/providers/update-provider'
import { SettingsSection } from './section'
import { UpdateField } from './update-field'

export function AboutSection(): ReactElement {
  const version = useAppVersion()
  const crashTap = useCrashTestTap()
  const { supported } = useUpdate()
  return (
    <SettingsSection id="about">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">Reflect Open</div>
        </div>
        <span onClick={crashTap} className="shrink-0 text-sm text-text-secondary">
          {version !== null ? `v${version}` : '—'}
        </span>
      </div>
      {supported ? <UpdateField /> : null}
    </SettingsSection>
  )
}
