import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CloudSyncBanner } from './cloud-sync-banner'

describe('CloudSyncBanner', () => {
  it('maps known provider ids to human labels', () => {
    const view = render(<CloudSyncBanner provider="icloud" />)
    expect(view.container.textContent).toContain('This graph is inside iCloud Drive.')
    view.unmount()
  })

  it('shows an unknown provider id as-is', () => {
    const view = render(<CloudSyncBanner provider="syncthing" />)
    expect(view.container.textContent).toContain('This graph is inside syncthing.')
    view.unmount()
  })
})
