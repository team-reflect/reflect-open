import {
  Archive,
  History,
  Lock,
  LockOpen,
  MessageSquare,
  MessageSquareDot,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Settings,
  Share,
  SlidersHorizontal,
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
  chat: MessageSquare,
  'chat-active': MessageSquareDot,
  archive: Archive,
  filters: SlidersHorizontal,
}
