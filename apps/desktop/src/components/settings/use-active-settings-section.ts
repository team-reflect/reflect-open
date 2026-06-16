import { useEffect, useState, type RefObject } from 'react'
import { findScrollContainer, SECTION_JUMP_OFFSET_PX } from './section-scrolling'
import { SETTINGS_SECTIONS, settingsSectionDomId, type SettingsSectionId } from './sections'

/**
 * The reading line: a section is active while it is the last one whose top
 * has crossed this many pixels below the container's top edge. Sits just
 * under the jump offset so clicking a navigator entry always lands with that
 * entry active.
 */
const ACTIVATION_LINE_PX = SECTION_JUMP_OFFSET_PX + 16

/**
 * Tracks which settings section the user is reading. Listens to the settings
 * scroll container — found by walking up from `anchorRef`, which must be
 * rendered inside it — and recomputes on scroll and resize. The active
 * section is the last one whose top has crossed the reading line; once the
 * container is scrolled to the very bottom the final section wins instead,
 * since a short last card may never reach the line on its own.
 */
export function useActiveSettingsSection(
  anchorRef: RefObject<HTMLElement | null>,
): SettingsSectionId {
  const [activeId, setActiveId] = useState<SettingsSectionId>(SETTINGS_SECTIONS[0].id)

  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) {
      return
    }
    const container = findScrollContainer(anchor)
    if (!container) {
      return
    }

    // No rAF coalescing: browsers already deliver at most one scroll event
    // per frame, and the work is eight getBoundingClientRect calls.
    const compute = (): void => {
      const containerTop = container.getBoundingClientRect().top
      let current: SettingsSectionId = SETTINGS_SECTIONS[0].id
      for (const section of SETTINGS_SECTIONS) {
        const element = document.getElementById(settingsSectionDomId(section.id))
        if (element && element.getBoundingClientRect().top - containerTop <= ACTIVATION_LINE_PX) {
          current = section.id
        }
      }
      const atBottom =
        container.scrollTop > 0 &&
        container.scrollTop + container.clientHeight >= container.scrollHeight - 1
      setActiveId(atBottom ? SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]!.id : current)
    }
    compute()
    // ScrollRestored restores a saved scrollTop in its own effect, which runs
    // after this one (React flushes child effects first) and whose scroll
    // event only lands a frame later. Recompute in a microtask — after the
    // whole effect pass, before paint — so a revisited entry starts right.
    queueMicrotask(compute)
    container.addEventListener('scroll', compute, { passive: true })
    const resizeObserver = new ResizeObserver(compute)
    resizeObserver.observe(container)
    return () => {
      container.removeEventListener('scroll', compute)
      resizeObserver.disconnect()
    }
  }, [anchorRef])

  return activeId
}
