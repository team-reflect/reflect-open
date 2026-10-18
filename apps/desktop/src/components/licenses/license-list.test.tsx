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
      version: '1.0.0',
      ecosystem: 'npm',
      license: 'MIT',
      url: 'https://alpha.example',
      texts: [0],
    },
    {
      name: 'beta',
      version: '2.0.0',
      ecosystem: 'cargo',
      license: 'BSD-3-Clause AND MIT',
      url: 'https://beta.example',
      texts: [0, 1],
    },
    { name: 'gamma', version: '3.0.0', ecosystem: 'npm', license: 'ISC', texts: [] },
  ],
  texts: ['MIT License\n\nCopyright (c) Alpha', 'BSD 3-Clause License\n\nCopyright (c) Beta'],
}

async function mount() {
  return await renderInApp(
    <div className="flex h-96 flex-col">
      <LicenseEntries licenses={LICENSES} className="flex-1" />
    </div>,
  )
}

describe('LicenseEntries', () => {
  it('lists every entry with its version and license', async () => {
    await mount()

    const rows = page.getByRole('button', { expanded: false })
    await expect.element(rows.nth(0)).toMatchTextContent('alpha1.0.0MIT')
    await expect.element(rows.nth(1)).toMatchTextContent('beta2.0.0BSD-3-Clause AND MIT')
    await expect.element(rows.nth(2)).toMatchTextContent('gamma3.0.0ISC')
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
      .element(page.getByText('This package ships no license file. It is licensed under ISC.'))
      .toBeVisible()
  })

  it('opens the homepage in the system browser', async () => {
    const view = await mount()

    await userEvent.click(page.getByRole('button', { name: /^alpha/ }))
    await userEvent.click(page.getByRole('button', { name: 'Homepage' }))

    expect(view.appServices.opener.openedUrls()).toEqual(['https://alpha.example'])
  })
})
