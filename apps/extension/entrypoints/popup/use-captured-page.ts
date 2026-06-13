import { useEffect, useState } from 'react'
import { browser } from 'wxt/browser'
import { isCapturableUrl, type CapturedPage } from '@/lib/capture-message'

/**
 * Snapshot the active tab the moment the popup opens: URL + title from the
 * tab (the action invocation granted `activeTab`, so both are readable),
 * a JPEG of the visible viewport, and the page's selection. Screenshot and
 * selection both degrade to absent on pages Chrome restricts (chrome://,
 * the Web Store) — the capture still carries URL + title.
 */

export type CapturedPageState =
  | { status: 'loading' }
  | { status: 'uncapturable' }
  | { status: 'ready'; page: CapturedPage }

const SCREENSHOT_QUALITY = 85

async function snapshotActiveTab(): Promise<CapturedPageState> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!tab || tab.id === undefined || !isCapturableUrl(tab.url)) {
    return { status: 'uncapturable' }
  }

  let screenshotDataUrl: string | undefined
  try {
    screenshotDataUrl = await browser.tabs.captureVisibleTab({
      format: 'jpeg',
      quality: SCREENSHOT_QUALITY,
    })
  } catch {
    screenshotDataUrl = undefined // restricted page — capture without it
  }

  let selection: string | undefined
  try {
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? '',
    })
    const text = result?.result
    selection = typeof text === 'string' && text.trim() !== '' ? text : undefined
  } catch {
    selection = undefined // page refuses scripts — capture without it
  }

  return {
    status: 'ready',
    page: { url: tab.url, title: tab.title ?? '', screenshotDataUrl, selection },
  }
}

export function useCapturedPage(): CapturedPageState {
  const [state, setState] = useState<CapturedPageState>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    snapshotActiveTab().then(
      (snapshot) => {
        if (!cancelled) setState(snapshot)
      },
      () => {
        if (!cancelled) setState({ status: 'uncapturable' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])
  return state
}
