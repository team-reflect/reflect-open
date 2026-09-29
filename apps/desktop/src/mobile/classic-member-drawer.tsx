import type { ReactElement } from 'react'
import { ChevronRight } from 'lucide-react'
import { Drawer, DrawerBody, DrawerContent, DrawerTitle } from '@/components/ui/drawer.tsx'

const TITLE = 'Reflect Classic member?'

interface ClassicMemberDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSignIn: () => void
  onWebClaim: () => void
}

/** The two ways a Reflect Classic member unlocks the app: sign in here, or claim a code on the web. */
export function ClassicMemberDrawer({
  open,
  onOpenChange,
  onSignIn,
  onWebClaim,
}: ClassicMemberDrawerProps): ReactElement {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label={TITLE}>
        <DrawerTitle>{TITLE}</DrawerTitle>
        <DrawerBody className="gap-3 px-5">
          <Option
            title="Sign in here"
            badge="Recommended"
            detail="Instant. Renews while you stay subscribed."
            recommended
            onPress={onSignIn}
          />
          <Option
            title="Get an offer code on the web"
            detail="Redeem it in the App Store. One year."
            onPress={onWebClaim}
          />
          <p className="text-center text-xs leading-5 text-text-muted">
            Signing in only checks your subscription. Nothing is synced with Reflect Classic.
          </p>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}

function Option({
  title,
  badge,
  detail,
  recommended = false,
  onPress,
}: {
  title: string
  badge?: string
  detail: string
  recommended?: boolean
  onPress: () => void
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onPress}
      className={
        recommended
          ? 'flex items-center gap-3 rounded-xl border border-primary bg-primary/5 p-4 text-left ring-1 ring-primary'
          : 'flex items-center gap-3 rounded-xl border border-border bg-surface p-4 text-left'
      }
    >
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge !== undefined ? (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="text-sm text-text-secondary">{detail}</span>
      </span>
      <ChevronRight aria-hidden className="size-4 text-text-muted" />
    </button>
  )
}
