import type { GraphInfo } from '@reflect/core'
import type { XPostResolver } from '@meowdown/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { mapXPostMediaUrls, parseXPostId } from '@post-embed/schema'
import type { XPost } from '@post-embed/types'
import {
  peekArchivedPost,
  resolveArchivedPost,
  type ResolvedArchivedPost,
} from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

export const X_MEDIA_URL_PROTOCOLS = ['reflect-asset:']

// One mapped post per resolved archive, so a cached read keeps its identity.
const mappedPosts = new WeakMap<ResolvedArchivedPost, XPost>()

function mapArchivedPost(generation: number, id: string, archive: ResolvedArchivedPost): XPost {
  let post = mappedPosts.get(archive)
  if (!post) {
    const local = new Map(
      archive.resources.map((resource) => [
        resource.url,
        convertFileSrc(generation + '/x-media/' + id + '/' + resource.hash, 'reflect-asset'),
      ]),
    )
    post = mapXPostMediaUrls(archive.archive.data, (source) => local.get(source))
    mappedPosts.set(archive, post)
  }
  return post
}

export function createXPostResolver(generation: number | null): XPostResolver {
  const inflight = new Map<string, Promise<XPost | undefined>>()

  async function load(id: string): Promise<XPost | undefined> {
    if (generation === null) return
    const result = await resolveArchivedPost(generation, id)
    if (!result) return
    return mapArchivedPost(generation, id, result)
  }

  return (url) => {
    const id = parseXPostId(url)
    if (!id || generation === null) return
    const cached = peekArchivedPost(generation, id)
    if (cached) return mapArchivedPost(generation, id, cached)
    let pending = inflight.get(id)
    if (!pending) {
      pending = load(id).finally(() => inflight.delete(id))
      inflight.set(id, pending)
    }
    return pending
  }
}

// All consumers of a graph share pending reads. `@reflect/core/x-archive` keeps found
// archives until a capture rewrites them; a missing archive is read again next time.
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

/** Whether `url` is an X post whose archive `graph` has already resolved. */
export function isXPostResolved(graph: GraphInfo | null, url: string): boolean {
  const id = parseXPostId(url)
  return graph !== null && id !== undefined && peekArchivedPost(graph.generation, id) !== undefined
}
