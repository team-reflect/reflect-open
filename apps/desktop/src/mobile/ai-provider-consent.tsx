import type { ReactElement } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { TRANSCRIPTION_PROVIDERS, type AiProviderInfo } from '@reflect/core'

export const PRIVACY_POLICY_URL = 'https://reflect.app/privacy'

const TRANSCRIBING_PROVIDER_IDS: readonly string[] = TRANSCRIPTION_PROVIDERS

interface AiProviderConsentProps {
  provider: AiProviderInfo
  consented: boolean
  onConsentedChange: (value: boolean) => void
}

/**
 * The pre-save disclosure and consent block (App Review 5.1.1(i)/5.1.2(i),
 * https://developer.apple.com/app-store/review/guidelines/#data-use-and-sharing):
 * states what data leaves the device and which provider receives it, and
 * collects the explicit agreement that gates the submit button.
 */
export function AiProviderConsent({
  provider,
  consented,
  onConsentedChange,
}: AiProviderConsentProps): ReactElement {
  const sendsAudio = TRANSCRIBING_PROVIDER_IDS.includes(provider.id)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">
        When you use AI features, Reflect sends data directly to {provider.label} using this
        key: AI chat sends your messages and the notes the assistant reads
        {sendsAudio ? ', and audio memos send the recording audio for transcription' : ''}.
        Nothing passes through a Reflect server, and notes you mark as private are never
        sent.{' '}
        <button
          type="button"
          className="underline"
          onClick={() => {
            void openUrl(PRIVACY_POLICY_URL).catch(() => {})
          }}
        >
          Privacy policy
        </button>
      </p>
      <label className="flex items-center gap-2 py-1">
        <input
          type="checkbox"
          className="accent-accent"
          checked={consented}
          onChange={(event) => onConsentedChange(event.target.checked)}
        />
        <span className="text-sm text-text">
          I understand this data will be sent to {provider.label}
        </span>
      </label>
    </div>
  )
}
