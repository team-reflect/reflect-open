import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { CloudSyncBanner } from './cloud-sync-banner'

describe('CloudSyncBanner', () => {
  it('maps known provider ids to human labels', async () => {
    const view = await render(<CloudSyncBanner provider="icloud" />)
    expect(view.container.textContent).toContain('This graph is inside iCloud Drive.')
  })

  it('shows an unknown provider id as-is', async () => {
    const view = await render(<CloudSyncBanner provider="syncthing" />)
    expect(view.container.textContent).toContain('This graph is inside syncthing.')
  })
})
