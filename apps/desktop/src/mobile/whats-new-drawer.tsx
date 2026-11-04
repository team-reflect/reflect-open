import { startTransition, useState, ViewTransition, type ReactElement, type ReactNode } from 'react'
import { SiDiscord, SiGithub } from '@icons-pack/react-simple-icons'
import { Mail, Star } from 'lucide-react'
import type { FeedbackChannel } from '@reflect/app'
import { marketingVersion } from '@reflect/core'
import { GraphPattern } from '@/components/icons/graph-pattern.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Button } from '@/components/ui/button.tsx'
import { riseIn, WhatsNewItems } from '@/components/whats-new/whats-new-items.tsx'
import { useStore } from '@/lib/use-store.ts'
import { cn } from '@/lib/utils.ts'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/mobile/scroll-drawer.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import './whats-new-drawer.css'

const ICON_CLASS = 'size-5 text-accent dark:text-accent-hover'

const FEEDBACK_CHANNELS: readonly {
  channel: FeedbackChannel
  label: string
  icon: ReactElement
}[] = [
  { channel: 'discord', label: 'Discord', icon: <SiDiscord aria-hidden className={ICON_CLASS} /> },
  { channel: 'github', label: 'GitHub', icon: <SiGithub aria-hidden className={ICON_CLASS} /> },
  { channel: 'email', label: 'Email', icon: <Mail className={ICON_CLASS} strokeWidth={1.75} /> },
]

const PRIMARY_CLASS = 'h-12 w-full rounded-xl text-base font-semibold'

/**
 * The tinted card at the top of each page, with the brand graph in its corner.
 */
function HeaderCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'relative isolate flex flex-col items-start overflow-hidden rounded-2xl bg-accent/5 p-5 ring-1 ring-accent/10 ring-inset dark:bg-accent/15 dark:ring-accent/20',
        className,
      )}
    >
      <GraphPattern className="absolute top-0 -right-2 -z-10 h-28 w-32 text-accent/15 mask-radial-from-35% mask-radial-to-80% mask-radial-at-top-right dark:text-accent-hover/15" />
      {children}
    </div>
  )
}

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
  const items = gate.items ?? []
  const close = (): void => {
    setPage('whatsNew')
    setRated(false)
    whatsNew.dismiss()
  }
  const headerRise = riseIn(0)
  const continueRise = riseIn(items.length + 1)
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
        <ViewTransition key={page} enter="whats-new-page-in" exit="whats-new-page-out">
          <div data-whats-new className="flex min-h-0 flex-col">
            {page === 'whatsNew' ? (
              <DrawerBody className="gap-0 pt-6">
                <div className={headerRise.className} style={headerRise.style}>
                  <HeaderCard>
                    <p className="text-sm font-semibold text-accent dark:text-accent-hover">
                      New in Reflect
                    </p>
                    <DrawerTitle className="mt-1.5 px-0 pt-0 text-2xl leading-tight font-semibold tracking-tight text-text">
                      What’s new
                    </DrawerTitle>
                    <DrawerDescription className="mt-4">
                      <Badge variant="secondary" className="h-6 px-2.5 tabular-nums">
                        Version {marketingVersion(platform.appVersion)}
                      </Badge>
                    </DrawerDescription>
                  </HeaderCard>
                </div>
                <WhatsNewItems items={items} riseFrom={1} className="mt-4 px-1" />
                <Button
                  variant="raised"
                  className={cn('mt-5', PRIMARY_CLASS, continueRise.className)}
                  style={continueRise.style}
                  onClick={() => {
                    if (review.shouldAsk()) {
                      startTransition(() => {
                        setPage('review')
                      })
                    } else {
                      close()
                    }
                  }}
                >
                  Continue
                </Button>
              </DrawerBody>
            ) : (
              <DrawerBody className="gap-0 pt-6">
                <HeaderCard>
                  <div aria-hidden className="flex gap-1 text-accent dark:text-accent-hover">
                    {[0, 1, 2, 3, 4].map((index) => (
                      <Star key={index} className="size-4 fill-current" strokeWidth={1.5} />
                    ))}
                  </div>
                  <DrawerTitle className="mt-3 px-0 pt-0 text-2xl leading-tight font-semibold tracking-tight text-text">
                    Enjoying Reflect?
                  </DrawerTitle>
                  <DrawerDescription className="mt-2 max-w-68 text-base/relaxed text-text-secondary">
                    We’re a small, independent team. Every App Store rating helps new people find
                    Reflect.
                  </DrawerDescription>
                </HeaderCard>
                <Button
                  variant="raised"
                  className={cn('mt-5', PRIMARY_CLASS)}
                  onClick={() => {
                    if (rated) {
                      review.writeReview()
                    } else {
                      setRated(true)
                      review.requestReview()
                    }
                  }}
                >
                  <Star />
                  {rated ? 'Write a review' : 'Rate Reflect'}
                </Button>
                <p className="mt-5 flex items-center gap-3 text-sm text-text-secondary">
                  <span aria-hidden className="h-px flex-1 bg-border" />
                  Or tell us directly
                  <span aria-hidden className="h-px flex-1 bg-border" />
                </p>
                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  {FEEDBACK_CHANNELS.map(({ channel, label, icon }) => (
                    <Button
                      key={channel}
                      variant="outline"
                      className="h-auto min-h-15 flex-col gap-1 rounded-xl text-xs"
                      onClick={() => review.sendFeedback(channel)}
                    >
                      {icon}
                      {label}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="ghost"
                  className="mt-3 h-11 self-center px-5 text-base text-text-secondary"
                  onClick={close}
                >
                  Not now
                </Button>
              </DrawerBody>
            )}
          </div>
        </ViewTransition>
      </DrawerContent>
    </Drawer>
  )
}
