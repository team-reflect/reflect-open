import { settingsSectionDomId, type SettingsSectionId } from './sections.ts'

/**
 * Breathing room (px) left above a section's heading when jumping to it —
 * matches the settings page's `py-8` so a jumped-to heading sits exactly
 * where the page's own top padding would put it.
 */
export const SECTION_JUMP_OFFSET_PX = 32

/**
 * The nearest ancestor that actually scrolls. Used instead of
 * `Element.scrollIntoView`, which walks the whole ancestor chain and can
 * permanently nudge `overflow: hidden` boxes like the workspace frame —
 * scrolling the one container that owns the settings overflow keeps the rest
 * of the layout pinned.
 */
export function findScrollContainer(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return parent
    }
  }
  return null
}

/**
 * Scrolls the settings page so the given section's heading lands just below
 * the container's top edge. `anchor` is any element inside the settings
 * scroll container (the navigator passes its own node). Smooth unless the OS
 * asks for reduced motion.
 */
export function scrollToSettingsSection(anchor: HTMLElement, id: SettingsSectionId): void {
  const target = document.getElementById(settingsSectionDomId(id))
  const container = findScrollContainer(anchor)
  if (!target || !container) {
    return
  }
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
  container.scrollTo({
    top: Math.max(0, container.scrollTop + offset - SECTION_JUMP_OFFSET_PX),
    behavior,
  })
}
