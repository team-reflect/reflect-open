import { useEffect, type ReactElement } from 'react'
import { canPromptForContacts, contactsAccessNotice, isContactsAvailable } from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useContactsState } from '@/hooks/use-contacts-state.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { CalendarIntegrationField } from './calendar-integration-field.tsx'
import { SettingsSection } from './section.tsx'
import { SettingsSwitchField } from './switch-field.tsx'

/**
 * The Integrations section: Apple Contacts and Calendar live together here
 * because both are OS-backed context sources. The Contacts switch is backed
 * by live `CNContactStore` reads — permission on/off is the whole state, so
 * there is no sync status to show. Turning it on triggers the OS permission
 * prompt; a denial keeps the switch on and points at System Settings, since
 * the app cannot re-prompt once the user has decided. The section renders
 * only where the framework exists (macOS/iOS) — see
 * {@link useVisibleSettingsSections}.
 */
export function IntegrationsSection(): ReactElement | null {
  const { settings } = useSettings()
  const { contacts, contactSuggestions } = useCoreServices()
  const { opener, calendarEvents } = useAppServices()
  const { authorization } = useContactsState()
  const prompt = useAsyncAction()

  // The user grants access in System Settings, not in the app, so re-read the
  // permission whenever the window regains focus while the integration is on.
  const contactsEnabled = settings.contactsEnabled
  useEffect(() => {
    if (!contactsEnabled) {
      return
    }
    function onFocus(): void {
      void contacts.refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [contactsEnabled, contacts])

  const contactsAvailable = isContactsAvailable(authorization)
  const calendarAvailable = calendarEvents.isAvailable()

  if (!contactsAvailable && !calendarAvailable) {
    return null
  }

  // `denied` points at System Settings; `prompt` offers the OS prompt again
  // (enabled but never asked), suppressed while a prompt is up so it doesn't
  // flash under the OS dialog on a fresh toggle.
  const notice = contactsAccessNotice(settings, authorization, prompt.pending)
  const showDenied = notice === 'denied'
  const showPrompt = notice === 'prompt'

  async function promptForAccess(): Promise<void> {
    // A failed prompt (e.g. it timed out unanswered) isn't surfaced here:
    // the refreshed status is the truth, and a denied/restricted answer
    // shows the System Settings pointer below.
    await prompt.run(() => contactSuggestions.requestAccess())
  }

  async function enableContacts(): Promise<void> {
    contactSuggestions.setEnabled(true)
    if (canPromptForContacts(authorization)) {
      await promptForAccess()
    }
  }

  return (
    <SettingsSection id="integrations">
      {contactsAvailable ? (
        <div>
          <SettingsSwitchField
            legend="Contacts"
            description="Suggest a contact's email and phone when a note's title matches their name."
            checked={settings.contactsEnabled}
            onCheckedChange={(checked) => {
              if (checked) {
                void enableContacts()
              } else {
                contactSuggestions.setEnabled(false)
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
                    opener.openSystemSettings('contacts')
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
      ) : null}
      <CalendarIntegrationField />
    </SettingsSection>
  )
}
