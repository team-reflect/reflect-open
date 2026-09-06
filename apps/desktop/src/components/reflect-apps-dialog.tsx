import type { ReactElement, RefObject } from 'react'
import { ArrowUpRight, Globe, Smartphone, X } from 'lucide-react'
import reflectAppsHero from '@/assets/reflect-apps-hero.png'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { openUrlSync } from '@/lib/open-url'

interface ReflectAppsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  finalFocus: RefObject<HTMLButtonElement | null>
}

const REFLECT_APPS = [
  {
    name: 'Reflect for iOS',
    platform: 'iPhone & iPad',
    description: 'Capture ideas and revisit your notes, wherever you are.',
    action: 'Get iOS app',
    url: 'https://apps.apple.com/us/app/reflect-open/id6787385615',
    icon: Smartphone,
  },
  {
    name: 'Reflect Capture',
    platform: 'Chrome extension',
    description: 'Save pages, quotes, and links straight to your daily note.',
    action: 'Get Chrome extension',
    url: 'https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd',
    icon: Globe,
  },
]

/** Companion apps and their install pages, opened in the system browser. */
export function ReflectAppsDialog({
  open,
  onOpenChange,
  finalFocus,
}: ReflectAppsDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={finalFocus}
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl p-0 shadow-pop sm:max-w-xl"
      >
        <div className="relative overflow-hidden rounded-t-2xl">
          <img
            src={reflectAppsHero}
            alt=""
            width={1774}
            height={887}
            className="block aspect-8/3 w-full object-cover"
          />
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-3 right-3 rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white"
              />
            }
          >
            <X aria-hidden strokeWidth={1.75} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <div className="p-6 pb-5">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-2xl leading-tight tracking-tight">
              Take Reflect with you
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-text-secondary">
              A home for your ideas. On the go and on the web.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {REFLECT_APPS.map((app) => (
              <section key={app.url} className="flex flex-col rounded-lg border border-border p-4">
                <div className="mb-3 flex items-center gap-2.5 text-2xs text-text-muted">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-text">
                    <app.icon aria-hidden className="size-4" strokeWidth={1.75} />
                  </span>
                  {app.platform}
                </div>
                <h3 className="text-base font-medium tracking-tight text-text">{app.name}</h3>
                <p className="mt-1.5 mb-4 flex-1 text-xs leading-relaxed text-text-secondary">
                  {app.description}
                </p>
                <Button
                  className="h-9 w-full justify-between gap-2 bg-accent px-3 text-xs text-text-on-brand hover:bg-accent-hover"
                  onClick={() => openUrlSync(app.url)}
                >
                  {app.action}
                  <ArrowUpRight aria-hidden className="size-3.5" strokeWidth={1.75} />
                </Button>
              </section>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
