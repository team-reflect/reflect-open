import { useState, type ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { LicensesDialog } from '@/components/licenses/licenses-dialog.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useAppVersion } from '@/hooks/use-app-version.ts'
import { useCrashTest, useDebugUnlockTap } from '@/hooks/use-debug-unlock.ts'
import { setPerfHudEnabled, usePerfHudEnabled } from '@/perf-hud/flag.ts'
import { useUpdate } from '@/providers/update-provider.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'
import { UpdateField } from './update-field.tsx'

export function AboutSection(): ReactElement {
  const version = useAppVersion()
  const { unlocked: debugUnlocked, tap: versionTap } = useDebugUnlockTap()
  const crashTest = useCrashTest()
  const perfHudEnabled = usePerfHudEnabled()
  const { supported } = useUpdate()
  const [licensesOpen, setLicensesOpen] = useState(false)
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
      <button
        type="button"
        onClick={() => setLicensesOpen(true)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left"
      >
        <span className="text-sm font-medium text-text">Open Source Licenses</span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-text-muted" />
      </button>
      {debugUnlocked ? (
        <>
          <div className="flex items-center justify-between gap-4 px-4 py-3.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-text">Debug</div>
            </div>
            <Button variant="destructive" size="sm" onClick={crashTest}>
              Trigger test error
            </Button>
          </div>
          <SettingsSwitchField
            legend="Performance HUD"
            description="Show frame rate and gesture timings in the corner."
            checked={perfHudEnabled}
            onCheckedChange={setPerfHudEnabled}
          />
        </>
      ) : null}
      {supported ? <UpdateField /> : null}
      <LicensesDialog open={licensesOpen} onOpenChange={setLicensesOpen} />
    </SettingsSection>
  )
}
