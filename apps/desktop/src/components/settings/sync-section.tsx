import type { ReactElement } from 'react'
import { GithubAccountField } from './github-account-field.tsx'
import { GitSyncSettingsField } from './git-sync-section.tsx'
import { IcloudSettingsField } from './icloud-section.tsx'
import { SettingsSection } from './section.tsx'

/**
 * Settings → Sync: where this graph syncs, as two cards side by side (iCloud
 * Drive, and a Git repository on GitHub or any other host), and under them
 * the machine's GitHub account, which belongs to no graph.
 */
export function SyncSection(): ReactElement {
  return (
    <SettingsSection id="sync">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-3 p-3">
        <IcloudSettingsField />
        <GitSyncSettingsField />
      </div>
      <GithubAccountField />
    </SettingsSection>
  )
}
