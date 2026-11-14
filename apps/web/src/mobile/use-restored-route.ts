import { routeSchema, sectionSchema } from '@reflect/app'
import { safeParseJson } from '@reflect/utils'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

const STORAGE_KEY = 'reflect.mobile.route'

const storedRouteSchema = z.object({
  graphRoot: z.string(),
  route: routeSchema,
  section: sectionSchema.optional(),
})

type StoredRoute = z.infer<typeof storedRouteSchema>

/**
 * In the Swift shell, keeps the current route and section of the graph in
 * session storage and returns the ones that were stored for the graph at mount.
 * Session storage outlives a reload of the page, so the app returns to the
 * same screen after the shell reloads a page whose process the system ended.
 *
 * The stored route is removed after it is read, and the next navigation
 * stores a route again. So a screen that ends the process again right after
 * it is restored is not restored a second time.
 */
export function useRestoredRoute(graphRoot: string): StoredRoute | undefined {
  const { navigation } = useAppServices()
  const { storage, platform } = useCoreServices()
  const enabled = platform.isSwiftMobile

  const [restored] = useState(() => {
    if (!enabled) {
      return
    }
    const stored = storedRouteSchema.safeParse(
      safeParseJson(storage.session.get(STORAGE_KEY) ?? ''),
    )
    return stored.success && stored.data.graphRoot === graphRoot ? stored.data : undefined
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    storage.session.set(STORAGE_KEY, null)
    return navigation.subscribe(() => {
      const { route, section } = navigation.get()
      storage.session.set(STORAGE_KEY, JSON.stringify({ graphRoot, route, section }))
    })
  }, [enabled, navigation, storage, graphRoot])

  return restored
}
