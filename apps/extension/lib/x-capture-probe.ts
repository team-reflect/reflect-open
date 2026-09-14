import { permalinkPostId } from './x-capture'
import { browser } from 'wxt/browser'
import {
  captureLookupResponseSchema,
  type CaptureProbeReport,
  type ProbeMediaResult,
} from './x-capture-messages'
import { collectProbeMedia, probeMedia } from './x-capture-media'

const activeTabs = new Set<number>()

/** Probe one permalink in its existing tab; keep its snapshot even when media fail. */
export async function runCaptureProbe(tabId: number, postId: string): Promise<CaptureProbeReport> {
  if (activeTabs.has(tabId)) throw new Error('probe-already-running')
  activeTabs.add(tabId)
  try {
    const tab = await browser.tabs.get(tabId)
    if (tab.incognito || !permalinkPostId(tab.url)) throw new Error('unsupported-tab')
    if (permalinkPostId(tab.url) !== postId) throw new Error('wrong-permalink')
    let raw: unknown
    try {
      raw = await browser.tabs.sendMessage(
        tabId,
        {
          type: 'x-capture:lookup',
          postId,
        },
        { frameId: 0 },
      )
    } catch {
      throw new Error('lookup-unavailable')
    }
    const parsed = captureLookupResponseSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid-snapshot')
    const answer = parsed.data
    if (!answer.ok) throw new Error(answer.reason)
    if (answer.post.id !== postId) throw new Error('wrong-post')
    const current = await browser.tabs.get(tabId)
    if (current.url !== tab.url || answer.pageUrl !== tab.url) throw new Error('page-changed')
    const counts = { videoCount: 0, mp4Available: 0, hlsOnly: 0, noSource: 0 }
    const results: ProbeMediaResult[] = []
    for (const media of collectProbeMedia(answer.post)) {
      const position = { slot: media.slot, unavailable: media.unavailable }
      if (media.kind === 'unsupported') {
        counts.videoCount++
        if (media.reason === 'hls-only') counts.hlsOnly++
        else counts.noSource++
        results.push({ ...position, status: 'unsupported', reason: media.reason })
        continue
      }
      if (media.kind === 'video') {
        counts.videoCount++
        counts.mp4Available++
      }
      try {
        const read = await probeMedia(media.url, media.kind)
        results.push({ ...position, status: 'read', kind: media.kind, ...read })
      } catch (error) {
        results.push({
          ...position,
          status: 'failed',
          kind: media.kind,
          reason: error instanceof Error ? error.message : 'media-failed',
        })
      }
    }
    return { post: answer.post, documentToken: answer.documentToken, counts, results }
  } finally {
    activeTabs.delete(tabId)
  }
}
