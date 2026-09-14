import { useEffect, useMemo } from 'react'
import { hasBridge, subscribeFileChanges, subscribeReconcileRequests } from '@reflect/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  mapXPostMediaUrls,
  parseXPostId,
  type XPost,
  type MediaUrlResolver,
} from '@post-embed/types'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

export class XPostResolverHost {
  readonly #generation: number | null
  readonly #subscribers = new Map<string, Set<() => void>>()
  readonly #fingerprints = new Map<string, string>()
  readonly #posts = new Map<string, XPost>()
  readonly #allowedByPost = new Map<string, Set<string>>()
  readonly #inflight = new Map<string, Promise<XPost | undefined>>()
  readonly #resourceStates = new Map<string, string>()
  // FIXME: `#retryTokens` / `?retry=N` cache busting exists because the protocol handler may 503
  // after 30s while the download continues and the browser then remembers the failed <img>. The
  // response already carries `Cache-Control: no-store`, and with desktop-driven downloads plus an
  // event (see extension lib/x-download.ts) the URL never needs to change. `#fingerprints`
  // (JSON.stringify of the whole archive every 2s per subscribed post), `#epoch`, `#polling` and
  // `#resourceStates` are all bookkeeping for the polling design and go with it.
  // `x_archive_resolve` also returns `error` and `bytes` per resource that nothing here reads.
  readonly #retryTokens = new Map<string, number>()
  #active = true
  #epoch = 0
  #refreshing = false
  #refreshQueued = false
  readonly #unlisten: Array<() => void> = []

  constructor(generation: number | null) {
    this.#generation = generation
  }

  // FIXME: `#allowedByPost` exists only so post-embed's `getSafeUrl` accepts `reflect-asset:` URLs.
  // Every URL it allows was minted by this class from `generation/x-media/<id>/<hash>` and Rust
  // validates ownership again on request, so the map guards nothing. A prefix check against
  // `convertFileSrc(generation + '/x-media/', 'reflect-asset')`, or a protocol allowlist prop in
  // post-embed, replaces it.
  readonly resolveXPostMediaUrl: MediaUrlResolver = (url) => {
    if (!this.#active) return
    for (const allowed of this.#allowedByPost.values()) if (allowed.has(url)) return url
    return
  }

  readonly resolveXPost = (url: string): XPost | undefined | Promise<XPost | undefined> => {
    if (!this.#active || this.#generation === null || !parseXPostId(url)) return
    if (this.#posts.has(url)) return this.#posts.get(url)
    let pending = this.#inflight.get(url)
    if (!pending) {
      pending = this.#load(url).finally(() => {
        if (this.#inflight.get(url) === pending) this.#inflight.delete(url)
      })
      this.#inflight.set(url, pending)
    }
    return pending
  }

  readonly subscribeXPost = (url: string, notify: () => void): (() => void) => {
    const listeners = this.#subscribers.get(url) ?? new Set<() => void>()
    this.#subscribers.set(url, listeners)
    listeners.add(notify)
    return () => {
      listeners.delete(notify)
      if (listeners.size === 0) this.#subscribers.delete(url)
    }
  }

  #notify(url: string): void {
    for (const notify of this.#subscribers.get(url) ?? []) notify()
  }

  async #load(url: string): Promise<XPost | undefined> {
    const id = parseXPostId(url)
    if (!id || this.#generation === null || !this.#active) return
    const epoch = this.#epoch
    const result = await resolveArchivedPost(this.#generation, id)
    if (!this.#active || this.#epoch !== epoch) return
    if (!result) {
      const hadPost = this.#posts.delete(url)
      this.#allowedByPost.delete(url)
      this.#fingerprints.delete(url)
      if (hadPost) this.#notify(url)
      return
    }
    const local = new Map<string, string>()
    const allowed = new Set<string>()
    for (const resource of result.resources) {
      if (resource.state === 'unsupported') continue
      const identity = id + ':' + resource.hash
      const previousState = this.#resourceStates.get(identity)
      if (
        resource.state === 'stored' &&
        previousState !== undefined &&
        previousState !== 'stored'
      ) {
        this.#retryTokens.set(identity, (this.#retryTokens.get(identity) ?? 0) + 1)
      }
      this.#resourceStates.set(identity, resource.state)
      let runtime = convertFileSrc(
        this.#generation + '/x-media/' + id + '/' + resource.hash,
        'reflect-asset',
      )
      const retry = this.#retryTokens.get(identity)
      if (retry) runtime += '?retry=' + retry
      allowed.add(runtime)
      local.set(resource.url, runtime)
    }
    const data = mapXPostMediaUrls(result.archive.data, (source) => local.get(source))
    const fingerprint = JSON.stringify([result.archive, result.resources])
    const previous = this.#fingerprints.get(url)
    this.#fingerprints.set(url, fingerprint)
    this.#allowedByPost.set(url, allowed)
    this.#posts.set(url, data)
    if (previous !== fingerprint) this.#notify(url)
    return data
  }

  async #refresh(): Promise<void> {
    if (!this.#active) return
    this.#refreshQueued = true
    if (this.#refreshing) return
    this.#refreshing = true
    try {
      do {
        this.#refreshQueued = false
        for (const url of this.#posts.keys()) {
          if (!this.#subscribers.has(url)) {
            this.#posts.delete(url)
            this.#allowedByPost.delete(url)
            this.#fingerprints.delete(url)
          }
        }
        for (const url of this.#subscribers.keys()) {
          try {
            // Finish an initial read before re-reading the changed file.
            await this.#inflight.get(url)?.catch(() => {})
            if (!this.#active) return
            await this.#load(url)
          } catch {
            const hadPost = this.#posts.delete(url)
            this.#allowedByPost.delete(url)
            this.#fingerprints.delete(url)
            if (hadPost) this.#notify(url)
          }
        }
      } while (this.#refreshQueued && this.#active)
    } finally {
      this.#refreshing = false
    }
  }

  async start(): Promise<void> {
    this.#active = true
    if (this.#generation === null || !hasBridge()) return
    const epoch = this.#epoch
    const active = () => this.#active && this.#epoch === epoch
    const keep = (unlisten: () => void) => {
      if (active()) this.#unlisten.push(unlisten)
      else unlisten()
    }
    const refresh = () => {
      if (active()) void this.#refresh()
    }
    await Promise.all([
      subscribeFileChanges((changes) => {
        if (changes.some((change) => change.path.startsWith('assets/x/'))) refresh()
      }).then(keep),
      subscribeReconcileRequests(refresh).then(keep),
    ])
    // Close the gap between the first read and installing the listeners.
    if (active()) await this.#refresh()
  }

  stop(): void {
    this.#active = false
    this.#epoch++
    for (const unlisten of this.#unlisten.splice(0)) unlisten()
    this.#posts.clear()
    this.#fingerprints.clear()
    this.#allowedByPost.clear()
    this.#inflight.clear()
    for (const url of this.#subscribers.keys()) this.#notify(url)
  }
}

export function useXPostResolver() {
  const graph = useGraph({ optional: true })?.graph
  const generation = graph?.generation ?? null
  const host = useMemo(() => new XPostResolverHost(generation), [generation])
  useEffect(() => {
    void host.start().catch((error: unknown) => {
      console.error('X archive subscription failed:', error)
    })
    return () => host.stop()
  }, [host])
  return {
    resolveXPost: host.resolveXPost,
    subscribeXPost: host.subscribeXPost,
    resolveXPostMediaUrl: host.resolveXPostMediaUrl,
  }
}
