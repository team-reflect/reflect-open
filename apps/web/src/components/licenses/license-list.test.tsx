import { page, userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import type { Licenses } from '@/lib/licenses/licenses.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { LicenseEntries } from './license-list.tsx'

const LICENSES: Licenses = {
  entries: [
    {
      name: 'alpha',
      ecosystem: 'npm',
      license: 'MIT',
      url: 'https://alpha.example',
      texts: ['mit-alpha'],
    },
    {
      name: 'beta',
      ecosystem: 'cargo',
      license: 'BSD-3-Clause AND MIT',
      url: 'https://beta.example',
      texts: ['mit-alpha', 'bsd-beta'],
    },
    { name: 'gamma', ecosystem: 'npm', license: 'ISC', texts: [] },
  ],
  texts: {
    'bsd-beta': 'BSD 3-Clause License\n\nCopyright (c) Beta',
    'mit-alpha': 'MIT License\n\nCopyright (c) Alpha',
  },
}

async function mount() {
  return await renderInApp(
    <div className="flex h-96 flex-col">
      <LicenseEntries licenses={LICENSES} className="flex-1" />
    </div>,
  )
}

describe('LicenseEntries', () => {
  it('lists every entry with its license', async () => {
    await mount()

    const rows = page.getByRole('button', { expanded: false })
    await expect.element(rows.nth(0)).toMatchTextContent('alphaMIT')
    await expect.element(rows.nth(1)).toMatchTextContent('betaBSD-3-Clause AND MIT')
    await expect.element(rows.nth(2)).toMatchTextContent('gammaISC')
  })

  it('shows the license texts only while a row is expanded', async () => {
    await mount()
    const beta = page.getByRole('button', { name: /^beta/ })

    await userEvent.click(beta)
    await expect.element(beta).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByText('Copyright (c) Alpha')).toBeVisible()
    await expect.element(page.getByText('Copyright (c) Beta')).toBeVisible()

    await userEvent.click(beta)
    await expect.element(page.getByText('Copyright (c) Beta')).not.toBeInTheDocument()
  })

  it('names the license of an entry that ships no license file', async () => {
    await mount()

    await userEvent.click(page.getByRole('button', { name: /^gamma/ }))

    await expect
      .element(page.getByText('No license file is included. Licensed under ISC.'))
      .toBeVisible()
  })

  it('opens the homepage in the system browser', async () => {
    const view = await mount()

    await userEvent.click(page.getByRole('button', { name: /^alpha/ }))
    await userEvent.click(page.getByRole('button', { name: 'Homepage' }))

    expect(view.appServices.opener.openedUrls()).toEqual(['https://alpha.example'])
  })
})
