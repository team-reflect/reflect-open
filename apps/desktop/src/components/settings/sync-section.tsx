import type { ReactElement } from 'react'
import { BackupSettingsField } from './backup-section'
import { IcloudSettingsField } from './icloud-section'
import { SettingsSection } from './section'

/**
 * Settings → Sync: iCloud Drive and Git remote sync live together here. Keep
 * both controls visible so an iCloud-hosted graph can still manage its GitHub
 * backup.
 */
export function SyncSection(): ReactElement {
  return (
    <SettingsSection id="sync">
      <IcloudSettingsField />
      <BackupSettingsField />
    </SettingsSection>
  )
}
