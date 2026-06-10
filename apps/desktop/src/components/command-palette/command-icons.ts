import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Command,
  PanelLeft,
  RefreshCw,
  Search,
  Settings,
  Shuffle,
  Sparkles,
  SquarePen,
  SunMoon,
  type LucideIcon,
} from 'lucide-react'

/**
 * Palette row icons by command id — a UI-side map, not part of the command
 * contract: the registry stays host-agnostic (CLI and deep links don't render
 * icons), and an unmapped command just gets the generic glyph.
 */
const COMMAND_ICONS: Record<string, LucideIcon> = {
  'nav.today': CalendarDays,
  'note.new': SquarePen,
  'history.back': ArrowLeft,
  'history.forward': ArrowRight,
  'palette.open': Search,
  'note.random': Shuffle,
  'theme.toggle': SunMoon,
  'sidebar.toggle': PanelLeft,
  'settings.open': Settings,
  'semantic.enable': Sparkles,
  'index.rebuild': RefreshCw,
}

export function commandIcon(id: string): LucideIcon {
  return COMMAND_ICONS[id] ?? Command
}
