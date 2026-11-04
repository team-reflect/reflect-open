import { useState, type ReactElement } from 'react'
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
 * The mobile What's New drawer, open while the What's New gate shows. When
 * the review service asks, Continue turns to a review page instead of
 * closing. Every way of closing it marks the version seen.
 */
export function WhatsNewDrawer(): ReactElement {
  const { whatsNew, review } = useAppServices()
  const { platform } = useCoreServices()
  const gate = useStore(whatsNew.gate)
  const [page, setPage] = useState<'whatsNew' | 'review'>('whatsNew')
  const [rated, setRated] = useState(false)
  const close = (): void => {
    setPage('whatsNew')
    setRated(false)
    whatsNew.dismiss()
  }
  return (
    <Drawer
      open={gate.kind === 'whatsNew'}
      onOpenChange={(open) => {
        if (!open) {
          close()
        }
      }}
    >
      <DrawerContent>
        {page === 'whatsNew' ? (
          <>
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
              <Button
                className="w-full"
                onClick={() => {
                  if (review.shouldAsk()) {
                    setPage('review')
                  } else {
                    close()
                  }
                }}
              >
                Continue
              </Button>
            </DrawerBody>
          </>
        ) : (
          <>
            <DrawerTitle>Help others find Reflect</DrawerTitle>
            <DrawerBody>
              <DrawerDescription>
                Reflect is made by a small team. A rating on the App Store helps other people find
                it.
              </DrawerDescription>
              <div className="flex flex-col gap-2">
                <Button
                  className="w-full"
                  onClick={() => {
                    if (rated) {
                      review.writeReview()
                    } else {
                      setRated(true)
                      review.requestReview()
                    }
                  }}
                >
                  {rated ? 'Write a review' : 'Rate Reflect'}
                </Button>
                <p className="pt-2 text-center text-sm text-text-muted">Or send us feedback</p>
                <div className="grid grid-cols-3 gap-2">
                  <Button variant="outline" onClick={() => review.sendFeedback('discord')}>
                    Discord
                  </Button>
                  <Button variant="outline" onClick={() => review.sendFeedback('github')}>
                    GitHub
                  </Button>
                  <Button variant="outline" onClick={() => review.sendFeedback('email')}>
                    Email
                  </Button>
                </div>
                <Button className="w-full" variant="ghost" onClick={close}>
                  Not now
                </Button>
              </div>
            </DrawerBody>
          </>
        )}
      </DrawerContent>
    </Drawer>
  )
}
