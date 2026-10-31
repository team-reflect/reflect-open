import type { ReactElement } from 'react'
import { GithubAccountField } from './github-account-field.tsx'
import { SettingsSection } from './section.tsx'

/**
 * Settings → Accounts: the sign-ins of this machine, which belong to no
 * graph. Today that is GitHub, which serves GitHub repositories and gist
 * sharing.
 */
export function AccountsSection(): ReactElement {
  return (
    <SettingsSection id="accounts">
      <GithubAccountField />
    </SettingsSection>
  )
}
