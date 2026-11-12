import type { ReactElement } from 'react'
import { LicenseList } from '@/components/licenses/license-list.tsx'
import { ChromeTopBar } from '@/mobile/chrome/chrome-top-bar.tsx'
import { useRouterState, useRouterActions } from '@/routing/router.tsx'

/** The Open Source Licenses screen (route kind `licenses`), pushed from Settings. */
export function MobileLicenses(): ReactElement {
  const { canBack } = useRouterState()
  const { back, navigate } = useRouterActions()
  return (
    <div className="flex h-full w-screen flex-col pt-safe">
      <ChromeTopBar
        align="center"
        back={() => (canBack ? back() : navigate({ kind: 'settings' }))}
        title={<h1 className="truncate text-base font-semibold">Licenses</h1>}
      />
      <LicenseList className="flex-1 px-safe-offset-4 pt-3 pb-chrome-safe-offset-3" />
    </div>
  )
}
