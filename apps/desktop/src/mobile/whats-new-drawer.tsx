import {
  startTransition,
  useState,
  ViewTransition,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { Check, Mail, Star } from 'lucide-react'
import { marketingVersion } from '@reflect/core'
import type { FeedbackChannel } from '@reflect/app'
import { DiscordIcon } from '@/components/icons/discord-icon.tsx'
import { GitHubIcon } from '@/components/icons/github-icon.tsx'
import { useStore } from '@/lib/use-store.ts'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/mobile/scroll-drawer.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import './whats-new-drawer.css'

const FEEDBACK_CHANNELS: readonly {
  channel: FeedbackChannel
  label: string
  icon: ReactElement
}[] = [
  { channel: 'discord', label: 'Discord', icon: <DiscordIcon className="size-5" /> },
  { channel: 'github', label: 'GitHub', icon: <GitHubIcon className="size-5" /> },
  { channel: 'email', label: 'Email', icon: <Mail className="size-5" strokeWidth={1.75} /> },
]

/**
 * The style that puts a `whats-new-rise` line at `index` in the stagger.
 */
function riseAt(index: number): CSSProperties {
  return { '--whats-new-index': index } as CSSProperties
}

/**
 * A faint piece of the brand graph that runs off the header card's corner.
 */
function GraphPattern(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 140 120"
      overflow="visible"
      className="whats-new-graph"
      fill="none"
    >
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <path d="M24 30 L66 18 L112 36 L94 78 L52 70 Z" />
        <path d="M66 18 L52 70 M112 36 L150 14 M94 78 L150 108 M52 70 L36 130 M24 30 L-10 58 M66 18 L74 -10" />
      </g>
      <g fill="currentColor">
        <circle cx="66" cy="18" r="4" />
        <circle cx="112" cy="36" r="5" />
        <circle cx="94" cy="78" r="3.5" />
        <circle cx="52" cy="70" r="4.5" />
        <circle cx="24" cy="30" r="3" />
      </g>
    </svg>
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
              <DrawerBody className="whats-new gap-0 pt-6">
                <header className="whats-new-rise whats-new-card" style={riseAt(0)}>
                  <GraphPattern />
                  <p className="whats-new-eyebrow">New in Reflect</p>
                  <DrawerTitle className="whats-new-heading mt-1.5 px-0 pt-0">
                    What’s new
                  </DrawerTitle>
                  <DrawerDescription className="whats-new-version mt-4">
                    Version {marketingVersion(platform.appVersion)}
                  </DrawerDescription>
                </header>
                <ul className="mt-4 flex flex-col">
                  {items.map((item, index) => (
                    <li
                      key={item.title}
                      className="whats-new-rise whats-new-item flex gap-3.5 px-1 py-3.5"
                      style={riseAt(index + 1)}
                    >
                      <span className="whats-new-check">
                        <Check className="size-3.5" strokeWidth={2.75} />
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <p className="font-medium text-text">{item.title}</p>
                        <p className="leading-snug text-text-secondary">{item.body}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="whats-new-rise whats-new-primary mt-5"
                  style={riseAt(items.length + 1)}
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
                </button>
              </DrawerBody>
            ) : (
              <DrawerBody className="whats-new gap-0 pt-6">
                <div className="whats-new-card">
                  <GraphPattern />
                  <div aria-hidden className="whats-new-stars flex gap-1">
                    {[0, 1, 2, 3, 4].map((index) => (
                      <Star key={index} className="size-4" strokeWidth={1.5} />
                    ))}
                  </div>
                  <DrawerTitle className="whats-new-heading mt-3 px-0 pt-0">
                    Enjoying Reflect?
                  </DrawerTitle>
                  <DrawerDescription className="whats-new-copy mt-2">
                    We’re a small, independent team. Every App Store rating helps new people find
                    Reflect.
                  </DrawerDescription>
                </div>
                <button
                  type="button"
                  className="whats-new-primary mt-5"
                  onClick={() => {
                    if (rated) {
                      review.writeReview()
                    } else {
                      setRated(true)
                      review.requestReview()
                    }
                  }}
                >
                  <Star className="size-4" strokeWidth={2} />
                  {rated ? 'Write a review' : 'Rate Reflect'}
                </button>
                <p className="whats-new-divider mt-5">Or tell us directly</p>
                <div className="mt-2.5 grid grid-cols-3 gap-2">
                  {FEEDBACK_CHANNELS.map(({ channel, label, icon }) => (
                    <button
                      key={channel}
                      type="button"
                      className="whats-new-channel"
                      onClick={() => review.sendFeedback(channel)}
                    >
                      {icon}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="whats-new-quiet mt-3 self-center" onClick={close}>
                  Not now
                </button>
              </DrawerBody>
            )}
          </div>
        </ViewTransition>
      </DrawerContent>
    </Drawer>
  )
}
