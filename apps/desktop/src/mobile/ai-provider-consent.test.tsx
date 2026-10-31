import { describe, expect, it, vi } from 'vitest'
import { aiProvider } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { AiProviderConsent } from './ai-provider-consent.tsx'

describe('AiProviderConsent', () => {
  it('opens the privacy policy in the system browser', async () => {
    const view = await renderInApp(
      <AiProviderConsent
        provider={aiProvider('openai')}
        consented={false}
        onConsentedChange={() => {}}
      />,
    )

    await view.getByRole('button', { name: 'Privacy policy' }).click()
    await vi.waitFor(() => {
      expect(view.appServices.opener.openedUrls()).toEqual(['https://reflect.app/privacy'])
    })
  })

  it('reports checkbox changes to the owner', async () => {
    const onConsentedChange = vi.fn()
    const view = await renderInApp(
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
