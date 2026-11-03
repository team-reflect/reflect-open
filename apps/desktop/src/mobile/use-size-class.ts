import type { HorizontalSizeClass } from '@reflect/core'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The window's horizontal size class, re-rendered as it changes; `null`
 * while an iPad has not answered yet (see `SizeClassService`).
 */
export function useHorizontalSizeClass(): HorizontalSizeClass | null {
  return useStore(useAppServices().sizeClass)
}
