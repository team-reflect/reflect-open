import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { aiProvider } from '@reflect/core'
import { AiProviderConsent } from './ai-provider-consent'

const openUrl = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

afterEach(cleanup)

describe('AiProviderConsent', () => {
  it('opens the privacy policy in the system browser', () => {
    render(
      <AiProviderConsent
        provider={aiProvider('openai')}
        consented={false}
        onConsentedChange={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Privacy policy' }))
    expect(openUrl).toHaveBeenCalledWith('https://reflect.app/privacy')
  })

  it('reports checkbox changes to the owner', () => {
    const onConsentedChange = vi.fn()
    render(
      <AiProviderConsent
        provider={aiProvider('openai')}
        consented={false}
        onConsentedChange={onConsentedChange}
      />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: /I understand this data will be sent/ }))
    expect(onConsentedChange).toHaveBeenCalledWith(true)
  })
})
