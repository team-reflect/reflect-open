import type { HorizontalSizeClass } from '@reflect/core'
import { useAppServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * The window's horizontal size class, re-rendered as it changes; `null`
 * while an iPad has not answered yet (see `SizeClassService`).
 */
export function useHorizontalSizeClass(): HorizontalSizeClass | null {
  const { sizeClass } = useAppServices()
  return useServiceState(sizeClass, sizeClass.current)
}
