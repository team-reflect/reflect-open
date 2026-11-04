import type { ReactElement } from 'react'
import { marketingVersion } from '@reflect/core'
import { Button } from '@/components/ui/button.tsx'
import { useStore } from '@/lib/use-store.ts'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/mobile/scroll-drawer.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The mobile What's New drawer, open while the What's New gate shows. Every
 * way of closing it marks the version seen.
 */
export function WhatsNewDrawer(): ReactElement {
  const { whatsNew } = useAppServices()
  const { platform } = useCoreServices()
  const gate = useStore(whatsNew.gate)
  return (
    <Drawer
      open={gate.kind === 'whatsNew'}
      onOpenChange={(open) => {
        if (!open) {
          whatsNew.dismiss()
        }
      }}
    >
      <DrawerContent>
        <DrawerTitle>What’s New</DrawerTitle>
        <DrawerBody>
          <DrawerDescription>Version {marketingVersion(platform.appVersion)}</DrawerDescription>
          <ul className="flex flex-col gap-3">
            {gate.items?.map((item) => (
              <li key={item.title}>
                <p className="font-medium text-text">{item.title}</p>
                <p className="text-text-muted">{item.body}</p>
              </li>
            ))}
          </ul>
          <Button className="w-full" onClick={whatsNew.dismiss}>
            Continue
          </Button>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}
