import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { cn } from '@/lib/utils'
import { scrollToSettingsSection } from './section-scrolling'
import { type SettingsSectionId } from './sections'
import { useActiveSettingsSection } from './use-active-settings-section'
import { useVisibleSettingsSections } from './use-visible-settings-sections'

/** Where the sliding marker sits, in the rail's own coordinates. */
interface MarkerPosition {
  top: number
  height: number
}

interface SettingsNavigatorProps {
  className?: string
}

/**
 * The sticky "on this page" rail beside the settings column: one entry per
 * registered section, with an accent marker that slides along a hairline
 * track to the section currently being read. Clicking an entry
 * smooth-scrolls the page to its card. The settings route only shows the
 * rail when the gutter is wide enough (a container query), so it must cope
 * with mounting at `display: none` — the marker re-measures when the rail
 * gains a size.
 */
export function SettingsNavigator({ className }: SettingsNavigatorProps): ReactElement {
  const navRef = useRef<HTMLElement | null>(null)
  const itemRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>())
  const activeId = useActiveSettingsSection(navRef)
  const sections = useVisibleSettingsSections()
  const [marker, setMarker] = useState<MarkerPosition | null>(null)

  const measure = useCallback((): void => {
    const item = itemRefs.current.get(activeId)
    if (!item || item.offsetHeight === 0) {
      setMarker(null)
      return
    }
    setMarker({ top: item.offsetTop, height: item.offsetHeight })
  }, [activeId])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const nav = navRef.current
    if (!nav) {
      return
    }
    const resizeObserver = new ResizeObserver(() => measure())
    resizeObserver.observe(nav)
    return () => resizeObserver.disconnect()
  }, [measure])

  return (
    <nav ref={navRef} aria-label="Settings sections" className={cn('text-[13px]', className)}>
      <div className="relative flex flex-col border-l border-border">
        {marker !== null && (
          <span
            aria-hidden
            className="absolute -left-px top-0 w-0.5 rounded-full bg-accent transition-[transform,height] duration-200 ease-out motion-reduce:transition-none"
            style={{ transform: `translateY(${marker.top}px)`, height: `${marker.height}px` }}
          />
        )}
        {sections.map((section) => {
          const isActive = section.id === activeId
          return (
            <button
              key={section.id}
              type="button"
              ref={(node) => {
                if (node) {
                  itemRefs.current.set(section.id, node)
                } else {
                  itemRefs.current.delete(section.id)
                }
              }}
              aria-current={isActive ? 'location' : undefined}
              onClick={() => {
                if (navRef.current) {
                  scrollToSettingsSection(navRef.current, section.id)
                }
              }}
              className={cn(
                'truncate rounded-r-md py-1 pl-4 pr-2 text-left outline-none transition-colors duration-200',
                'focus-visible:ring-2 focus-visible:ring-ring/50',
                isActive ? 'text-text' : 'text-text-secondary hover:text-text',
              )}
            >
              {section.title}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
