import { useEffect, useState, type ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { requestContactsAccess } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert'
import {
  useContactsAuthorization,
  useRefreshContactsAuthorization,
} from '@/hooks/use-contacts-authorization'
import { useSettings } from '@/providers/settings-provider'
import { SettingsSection } from './section'
import { SettingsSwitchField } from './switch-field'

/**
 * macOS System Settings, opened straight to the Contacts privacy pane. This
 * scheme is macOS-only, which holds today: this section lives in the desktop
 * settings surface (mobile has its own settings drawer, which doesn't offer
 * the integration yet). An iOS settings surface would use `app-settings:`.
 */
const CONTACTS_PRIVACY_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts'

/**
 * The System integrations section (the contacts-integration port): a Contacts
 * switch backed by live `CNContactStore` reads — permission on/off is the
 * whole state, so there is no sync status to show. Turning it on triggers the
 * OS permission prompt; a denial keeps the switch on and points at System
 * Settings, since the app cannot re-prompt once the user has decided. The
 * section renders only where the framework exists (macOS/iOS) — see
 * {@link useVisibleSettingsSections}.
 */
export function IntegrationsSection(): ReactElement | null {
  const { settings, updateSettings } = useSettings()
  const authorization = useContactsAuthorization()
  const refreshAuthorization = useRefreshContactsAuthorization()
  const [isPrompting, setIsPrompting] = useState(false)

  // The user grants access in System Settings, not in the app, so re-read the
  // permission whenever the window regains focus while the integration is on.
  const contactsEnabled = settings.contactsEnabled
  useEffect(() => {
    if (!contactsEnabled) {
      return
    }
    function onFocus(): void {
      void refreshAuthorization()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [contactsEnabled, refreshAuthorization])

  if (authorization === null || authorization === 'unavailable') {
    return null
  }

  const showDenied =
    settings.contactsEnabled && (authorization === 'denied' || authorization === 'restricted')
  // Enabled but never asked — the toggle-on prompt didn't complete (quit
  // mid-prompt, settings restored from another machine). Offer the prompt
  // again rather than sitting silently gated off. Suppressed while a prompt
  // is up, so it doesn't flash under the OS dialog on a fresh toggle.
  const showPrompt =
    settings.contactsEnabled && authorization === 'notDetermined' && !isPrompting

  async function promptForAccess(): Promise<void> {
    setIsPrompting(true)
    try {
      // A failed prompt (e.g. it timed out unanswered) isn't surfaced here —
      // the refreshed status is the truth, and a denied/restricted answer
      // shows the System Settings pointer below.
      await requestContactsAccess().catch(() => {})
      await refreshAuthorization()
    } finally {
      setIsPrompting(false)
    }
  }

  async function enableContacts(): Promise<void> {
    updateSettings({ contactsEnabled: true })
    if (authorization === 'notDetermined') {
      await promptForAccess()
    }
  }

  return (
    <SettingsSection id="integrations">
      <div>
        <SettingsSwitchField
          legend="Contacts"
          description="Suggest a contact's email and phone when a note's title matches their name."
          checked={settings.contactsEnabled}
          onCheckedChange={(checked) => {
            if (checked) {
              void enableContacts()
            } else {
              updateSettings({ contactsEnabled: false })
            }
          }}
        />
        {showDenied ? (
          <div className="px-4 pb-3.5">
            <InlineAlert tone="warning">
              Reflect doesn’t have contacts access.{' '}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => {
                  // A rejection here is a capability-scope bug (the ACL must
                  // allow x-apple.systempreferences:*) — surface it, don't
                  // swallow it into a dead link.
                  openUrl(CONTACTS_PRIVACY_PANE).catch((cause: unknown) => {
                    console.error('failed to open System Settings', cause)
                  })
                }}
              >
                Open System Settings
              </button>{' '}
              to allow it, then return here.
            </InlineAlert>
          </div>
        ) : null}
        {showPrompt ? (
          <div className="px-4 pb-3.5">
            <InlineAlert tone="warning">
              Reflect hasn’t asked for contacts access yet.{' '}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => void promptForAccess()}
              >
                Allow contacts access
              </button>
            </InlineAlert>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  )
}
