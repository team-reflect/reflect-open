import { useEffect, useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  mapXPostMediaUrls,
  parseXPostId,
  type XPost,
  type MediaUrlResolver,
} from '@post-embed/types'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

// FIXME: rename XPostHost to XPostResolverHost
export class XPostHost {
  readonly #generation: number | null
  readonly #subscribers = new Map<string, Set<() => void>>()
  readonly #fingerprints = new Map<string, string>()
  readonly #posts = new Map<string, XPost>()
  readonly #allowedByPost = new Map<string, Set<string>>()
  readonly #inflight = new Map<string, Promise<XPost | undefined>>()
  readonly #resourceStates = new Map<string, string>()
  readonly #retryTokens = new Map<string, number>()
  #active = true
  #epoch = 0
  #polling = false
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(generation: number | null) {
    this.#generation = generation
  }

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

  async #poll(): Promise<void> {
    if (this.#polling || !this.#active) return
    this.#polling = true
    try {
      for (const url of this.#subscribers.keys()) {
        try {
          await this.#load(url)
        } catch {
          if (this.#posts.delete(url)) this.#notify(url)
          this.#allowedByPost.delete(url)
        }
      }
    } finally {
      this.#polling = false
    }
  }

  start(): void {
    this.#active = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = setInterval(() => {
      this.#poll().catch(() => {})
    }, 2000)
  }

  stop(): void {
    this.#active = false
    this.#epoch++
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#posts.clear()
    this.#allowedByPost.clear()
    this.#inflight.clear()
    for (const url of this.#subscribers.keys()) this.#notify(url)
  }
}

export function useXPostResolver() {
  const graph = useGraph({ optional: true })?.graph
  const generation = graph?.generation ?? null
  const host = useMemo(() => new XPostHost(generation), [generation])
  useEffect(() => {
    host.start()
    return () => host.stop()
  }, [host])
  return {
    resolveXPost: host.resolveXPost,
    subscribeXPost: host.subscribeXPost,
    resolveXPostMediaUrl: host.resolveXPostMediaUrl,
  }
}
