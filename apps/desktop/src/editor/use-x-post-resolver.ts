import { useEffect, useMemo } from 'react'
import { hasBridge, subscribeFileChanges, subscribeReconcileRequests } from '@reflect/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { mapXPostMediaUrls, parseXPostId } from '@post-embed/schema'
import type { XPost } from '@post-embed/types'
import { resolveArchivedPost } from '@reflect/core/x-archive'
import { useGraph } from '@/providers/graph-provider'

// FIXME: Delete the whole subscribe/revision mechanism across the three repos and simplify as far
// as possible. Today it is the only thing `revision` on the card is for, and it is no longer needed
// for media: `x_media_protocol.rs` keeps the reflect-asset request pending until
// `x_download::download` publishes the file, and the `index:changed` events for finished media
// (`assets/x/url_sha256_*`) are filtered out below anyway. What remains is 'the post JSON appears,
// changes or disappears after the card rendered'. The normal save flow never hits that:
// `capture-drain.ts` calls `saveArchivedPost` (writes `assets/x/post-<id>.json`) before
// `writeBookmark` appends the Markdown line, so by the time a card is created its JSON already
// exists. The only scenarios given up are: a hand-pasted X URL that is archived later, a
// cross-device sync that delivers the Markdown before the JSON, and re-saving the same tweet with
// updated text. In those cases the card keeps its old state until the note is reopened, which is
// acceptable. Meanwhile the mechanism has a real cost: `#refresh` notifies every subscribed URL on
// any `post-*.json` change and on every `index:reconcile` (watcher restart, wake from sleep,
// iCloud), so every X card in the note is re-rendered and every playing video is paused. Remove
// here: `#subscribers`, `subscribe`, `#notify`, `#refresh`, `#refreshing`/`#refreshQueued`, both
// `subscribeFileChanges`/`subscribeReconcileRequests` listeners, `#unlisten`, `#epoch` and the
// `start()` body that only exists to install them (leave `stop()` clearing the caches). Remove in
// meowdown: `XPostHost.subscribe`, the `subscribe` call and `#unsubscribeXPost` in
// `core/src/extensions/image.ts`, and the `useState`/`useEffect` revision pair in
// `react/src/components/markdown-view.tsx`. Remove in post-embed: `XPostProps.revision`, the
// `revision` prop declaration in `x-post.ts`, `FetchProps.revision` and the `props.revision.get()`
// read in `fetch.ts`, plus the 'refreshes the same URL when its host revision changes' test.
export class XPostResolverHost {
  readonly #generation: number | null
  readonly #subscribers = new Map<string, Set<() => void>>()
  readonly mediaUrlProtocols = ['reflect-asset:']
  readonly #posts = new Map<string, XPost | undefined>()
  readonly #inflight = new Map<string, Promise<XPost | undefined>>()
  #active = true
  // Invalidate async reads and late listener setup after stop/restart.
  #epoch = 0
  #refreshing = false
  #refreshQueued = false
  readonly #unlisten: Array<() => void> = []

  constructor(generation: number | null) {
    this.#generation = generation
  }

  readonly resolve = (url: string): XPost | undefined | Promise<XPost | undefined> => {
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

  readonly subscribe = (url: string, notify: () => void): (() => void) => {
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
      this.#posts.set(url, undefined)
      return
    }
    const local = new Map(
      result.resources.map((resource) => [
        resource.url,
        convertFileSrc(this.#generation + '/x-media/' + id + '/' + resource.hash, 'reflect-asset'),
      ]),
    )
    const data = mapXPostMediaUrls(result.archive.data, (source) => local.get(source))
    this.#posts.set(url, data)
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
          }
        }
        for (const url of this.#subscribers.keys()) {
          try {
            // Finish an initial read before re-reading the changed file.
            await this.#inflight.get(url)?.catch(() => {})
            if (!this.#active) return
            await this.#load(url)
            this.#notify(url)
          } catch {
            const hadPost = this.#posts.delete(url)
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
        if (
          changes.some(
            (change) => change.path.startsWith('assets/x/post-') && change.path.endsWith('.json'),
          )
        )
          refresh()
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
    this.#inflight.clear()
    for (const url of this.#subscribers.keys()) this.#notify(url)
  }
}

// FIXME: this creates one host per component instance: NoteEditor, MarkdownPreview and *every*
// BacklinkSnippet each get their own `#posts` cache, their own in-flight map and (today) their own
// pair of file-change listeners, so the same post is resolved and its downloads re-triggered once
// per snippet. Create one host per graph instead (a value on the graph context, or a module-level
// `Map<generation, host>`), and have this hook only look it up. Also `#load` caches a missing
// archive as `undefined` for the host's whole lifetime; once the subscription is gone, do not cache
// negative results, so a later render can pick up an archive that arrived in the meantime.
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
  return host
}
