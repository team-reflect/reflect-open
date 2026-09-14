import type { GraphInfo } from '@reflect/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { mapXPostMediaUrls, parseXPostId } from '@post-embed/schema'
import type { XPost } from '@post-embed/types'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

export class XPostResolverHost {
  readonly #generation: number | null
  readonly mediaUrlProtocols = ['reflect-asset:']
  readonly #inflight = new Map<string, Promise<XPost | undefined>>()

  constructor(generation: number | null) {
    this.#generation = generation
  }

  readonly resolve = (url: string): Promise<XPost | undefined> | undefined => {
    const id = parseXPostId(url)
    if (!id || this.#generation === null) return
    let pending = this.#inflight.get(id)
    if (!pending) {
      pending = this.#load(id).finally(() => this.#inflight.delete(id))
      this.#inflight.set(id, pending)
    }
    return pending
  }

  async #load(id: string): Promise<XPost | undefined> {
    if (this.#generation === null) return
    const result = await resolveArchivedPost(this.#generation, id)
    if (!result) return
    const local = new Map(
      result.resources.map((resource) => [
        resource.url,
        convertFileSrc(this.#generation + '/x-media/' + id + '/' + resource.hash, 'reflect-asset'),
      ]),
    )
    return mapXPostMediaUrls(result.archive.data, (source) => local.get(source))
  }
}

// All consumers of a graph share pending reads. No result cache: reopening a card
// reads updated JSON, including an archive that was missing on its first render.
const hosts = new WeakMap<GraphInfo, XPostResolverHost>()
const emptyHost = new XPostResolverHost(null)

export function getXPostResolverHost(graph: GraphInfo | null): XPostResolverHost {
  if (!graph) return emptyHost
  let host = hosts.get(graph)
  if (!host) {
    host = new XPostResolverHost(graph.generation)
    hosts.set(graph, host)
  }
  return host
}

export function useXPostResolver() {
  return getXPostResolverHost(useGraph({ optional: true })?.graph ?? null)
}
