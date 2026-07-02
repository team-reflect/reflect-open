/**
 * Whether editors render inside a touch webview (the mobile app). Set once by
 * the mobile root chunk at module load — before any editor mounts — the same
 * pattern as `setLocalWriteEcho`. Editors read it to apply iOS text-input
 * hygiene (Plan 19, decision 7 gate): a pinned `spellcheck=false` (WebKit
 * derives the keyboard's smart-quotes/smart-dashes traits from it, and smart
 * punctuation corrupts markdown syntax) and explicit input traits — see
 * `EditorInputTraits`.
 */
let touchSurface = false

/** Mark editors as rendering on a touch webview. Mobile root chunk only. */
export function setTouchEditorSurface(value: boolean): void {
  touchSurface = value
}

/** True when editors render on a touch webview (the mobile app). */
export function isTouchEditorSurface(): boolean {
  return touchSurface
}
