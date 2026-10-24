import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { useCoreServices, useGraphServices } from '@/services/services-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

function AppVersion() {
  const { platform } = useCoreServices()
  return <p>version {platform.appVersion}</p>
}

function GraphRoot() {
  const { session, role } = useGraphServices()
  return (
    <p>
      {role} {session.root}
    </p>
  )
}

describe('services providers', () => {
  it('gives components the app services', async () => {
    const screen = await renderInApp(<AppVersion />, { servicesOnly: true })
    await expect.element(screen.getByText('version 0.0.0-test')).toBeVisible()
    expect(screen.core.platform.appVersion).toBe('0.0.0-test')
  })

  it('gives components the graph services', async () => {
    const screen = await renderInApp(<GraphRoot />, { route: null })
    await expect.element(screen.getByText('main /graphs/test')).toBeVisible()
  })

  it('throws outside the providers', async () => {
    await expect(render(<AppVersion />)).rejects.toThrow(
      /useCoreServices\(\) must be called inside an <CoreServicesProvider>/,
    )
  })
})
