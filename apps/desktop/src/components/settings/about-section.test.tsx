import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { AboutSection } from './about-section.tsx'

describe('AboutSection', () => {
  it('copies the diagnostics report', async () => {
    const { core, appServices } = await renderInApp(<AboutSection />, {
      wrapper: (children) => <UpdateProvider autoCheck={false}>{children}</UpdateProvider>,
    })

    await page.getByRole('button', { name: 'Copy' }).click()

    await vi.waitFor(() => expect(appServices.clipboard.writes()).toHaveLength(1))
    expect(appServices.clipboard.writes()).toEqual([await core.diagnostics.collect()])
  })
})
