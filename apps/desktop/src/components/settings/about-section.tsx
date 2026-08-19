import type { ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { useAppVersion } from '@/hooks/use-app-version'
import { useCrashTest, useDebugUnlockTap } from '@/hooks/use-debug-unlock'
import { useUpdate } from '@/providers/update-provider'
import { SettingsSection } from './section'
import { UpdateField } from './update-field'

export function AboutSection(): ReactElement {
  const version = useAppVersion()
  const { unlocked: debugUnlocked, tap: versionTap } = useDebugUnlockTap()
  const crashTest = useCrashTest()
  const { supported } = useUpdate()
  return (
    <SettingsSection id="about">
      <div className="flex items-center justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text">Reflect Open</div>
        </div>
        <span onClick={versionTap} className="shrink-0 text-sm text-text-secondary">
          {version !== null ? `v${version}` : '—'}
        </span>
      </div>
      {debugUnlocked ? (
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-text">Debug</div>
          </div>
          <Button variant="destructive" size="sm" onClick={crashTest}>
            Trigger test error
          </Button>
        </div>
      ) : null}
      {supported ? <UpdateField /> : null}
    </SettingsSection>
  )
}
