import type { ReactElement, RefObject } from 'react'
import { ArrowUpRight, Globe, Smartphone, X, type LucideIcon } from 'lucide-react'
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
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly finalFocus: RefObject<HTMLButtonElement | null>
}

interface ReflectApp {
  readonly name: string
  readonly platform: string
  readonly description: string
  readonly action: string
  readonly url: string
  readonly icon: LucideIcon
}

const REFLECT_APPS: readonly ReflectApp[] = [
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
    platform: 'Browser extension',
    description: 'Send pages, highlights, and links to your daily note.',
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
        className="max-h-[calc(100dvh-2rem)] animate-none! gap-0 overflow-y-auto rounded-2xl p-0 shadow-pop transition-opacity duration-150 ease-out sm:max-w-xl data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[ending-style]:duration-100 motion-reduce:transition-none"
      >
        <div className="relative overflow-hidden rounded-t-2xl">
          <img
            src={reflectAppsHero}
            alt=""
            width={1774}
            height={887}
            className="block aspect-8/3 w-full object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
          />
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-3 right-3 rounded-full bg-white/10 text-white/80 transition-[background-color,color,box-shadow,border-color,translate] duration-150 ease-out after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-1/2 hover:bg-white/20 hover:text-white sm:after:size-10 motion-reduce:transition-none motion-reduce:active:not-aria-[haspopup]:translate-y-0"
              />
            }
          >
            <X aria-hidden strokeWidth={1.75} />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>
        <div className="p-6 pb-5">
          <DialogHeader className="gap-2">
            <DialogTitle className="text-2xl leading-tight tracking-tight text-balance">
              Take Reflect with you
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-pretty text-text-secondary">
              Take notes on the go. Capture articles and save links.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {REFLECT_APPS.map((app) => (
              <section key={app.url} className="flex flex-col rounded-lg border border-border p-4">
                <div className="mb-3 flex items-center gap-2.5 text-2xs text-text-secondary">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-text">
                    <app.icon aria-hidden className="size-4" strokeWidth={1.75} />
                  </span>
                  {app.platform}
                </div>
                <h3 className="text-base font-medium tracking-tight text-balance text-text">
                  {app.name}
                </h3>
                <p className="mt-1.5 mb-4 flex-1 text-xs leading-relaxed text-pretty text-text-secondary">
                  {app.description}
                </p>
                <Button
                  className="relative h-9 w-full justify-between gap-2 bg-accent pr-2.5 pl-3 text-xs text-text-on-brand transition-[background-color,color,box-shadow,border-color,translate] duration-150 ease-out after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 hover:bg-accent-hover sm:after:h-10 motion-reduce:transition-none motion-reduce:active:not-aria-[haspopup]:translate-y-0"
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
