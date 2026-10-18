import type { ReactElement } from 'react'
import { LicenseList } from '@/components/licenses/license-list.tsx'
import { MobileScreenHeader } from '@/mobile/screen-header.tsx'
import { useRouter } from '@/routing/router.tsx'

/** The Open Source Licenses screen (route kind `licenses`), pushed from Settings. */
export function MobileLicenses(): ReactElement {
  const { back, canBack, navigate } = useRouter()
  return (
    <div
      className="flex h-full w-screen flex-col"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <MobileScreenHeader
        title="Licenses"
        onBack={() => (canBack ? back() : navigate({ kind: 'settings' }))}
      />
      <LicenseList className="flex-1 px-4 py-3" />
    </div>
  )
}
