import type { GraphInfo } from '@reflect/core'
import type { XPostResolver } from '@meowdown/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { mapXPostMediaUrls, parseXPostId } from '@post-embed/schema'
import type { XPost } from '@post-embed/types'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

export const X_MEDIA_URL_PROTOCOLS = ['reflect-asset:']

export function createXPostResolver(generation: number | null): XPostResolver {
  const inflight = new Map<string, Promise<XPost | undefined>>()

  async function load(id: string): Promise<XPost | undefined> {
    if (generation === null) return
    const result = await resolveArchivedPost(generation, id)
    if (!result) return
    const local = new Map(
      result.resources.map((resource) => [
        resource.url,
        convertFileSrc(generation + '/x-media/' + id + '/' + resource.hash, 'reflect-asset'),
      ]),
    )
    return mapXPostMediaUrls(result.archive.data, (source) => local.get(source))
  }

  return (url) => {
    const id = parseXPostId(url)
    if (!id || generation === null) return
    let pending = inflight.get(id)
    if (!pending) {
      pending = load(id).finally(() => inflight.delete(id))
      inflight.set(id, pending)
    }
    return pending
  }
}

// All consumers of a graph share pending reads. No result cache: reopening a card
// reads updated JSON, including an archive that was missing on its first render.
const resolvers = new WeakMap<GraphInfo, XPostResolver>()
const emptyResolver = createXPostResolver(null)

export function getXPostResolver(graph: GraphInfo | null): XPostResolver {
  if (!graph) return emptyResolver
  let resolver = resolvers.get(graph)
  if (!resolver) {
    resolver = createXPostResolver(graph.generation)
    resolvers.set(graph, resolver)
  }
  return resolver
}

export function useXPostResolver() {
  return getXPostResolver(useGraph({ optional: true })?.graph ?? null)
}
