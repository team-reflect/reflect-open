import type { ReactElement } from 'react'
import { GitSyncSettingsField } from './git-sync-section.tsx'
import { IcloudSettingsField } from './icloud-section.tsx'
import { SettingsSection } from './section.tsx'

/**
 * Settings → Sync: where this graph syncs. iCloud Drive and a Git repository
 * live together here.
 */
export function SyncSection(): ReactElement {
  return (
    <SettingsSection id="sync">
      <IcloudSettingsField />
      <GitSyncSettingsField />
    </SettingsSection>
  )
}
