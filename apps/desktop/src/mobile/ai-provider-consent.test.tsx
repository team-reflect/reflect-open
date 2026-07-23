import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { aiProvider } from '@reflect/core'
import { AiProviderConsent } from './ai-provider-consent'

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

describe('AiProviderConsent', () => {
  it('opens the privacy policy in the system browser', async () => {
    const view = await render(
      <AiProviderConsent
        provider={aiProvider('openai')}
        consented={false}
        onConsentedChange={() => {}}
      />,
    )

    await view.getByRole('button', { name: 'Privacy policy' }).click()
    expect(openUrl).toHaveBeenCalledWith('https://reflect.app/privacy')
  })

  it('reports checkbox changes to the owner', async () => {
    const onConsentedChange = vi.fn()
    const view = await render(
      <AiProviderConsent
        provider={aiProvider('openai')}
        consented={false}
        onConsentedChange={onConsentedChange}
      />,
    )

    await view.getByRole('checkbox', { name: /I understand this data will be sent/ }).click()
    expect(onConsentedChange).toHaveBeenCalledWith(true)
  })
})
