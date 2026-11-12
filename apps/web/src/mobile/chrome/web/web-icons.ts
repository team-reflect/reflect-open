import {
  History,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Settings,
  Share,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import type { ChromeIcon } from '@/mobile/chrome/screen-chrome.ts'

/**
 * The web drawing of every chrome icon.
 */
export const WEB_ICONS: Record<ChromeIcon, LucideIcon> = {
  settings: Settings,
  plus: Plus,
  history: History,
  ellipsis: MoreHorizontal,
  pin: Pin,
  'pin-off': PinOff,
  lock: Lock,
  'lock-open': LockOpen,
  share: Share,
  trash: Trash2,
}
