# Porting assets and images

**v2 status: replaced.** V1 mobile's encrypted asset pipeline exists to
serve encrypted cloud blobs offline; v2 assets are plain files under
`assets/`, so most of it dissolves. What ports is the **experience
contract** (images load instantly and work offline) and the photo-insertion
flow, which returns with the editor-toolbar work.

## What V1 mobile does

- **Upload**: files are encrypted client-side (`@team-reflect/file-crypto`
  in a worker) and uploaded. Insertion is optimistic: a temporary URL
  renders at once, the confirmed upload follows (50 MB cap,
  `helpers/editor/editor-file-upload-handler.ts`).
- **Native cache**: encrypted blobs are cached in `Library/Caches/AssetsCache`
  by the Assets plugin (`ios/App/App/Capacitor Plugins/AssetsPlugin/`). A
  `reserveUpload → addUpload → getUpload` bridge protocol
  (`capacitor/assets.ts`) coordinates the webview crypto pipeline with the
  cache and resolves upload/download races.
- **Serving**: a `reflect-assets://` WKWebView scheme handler fetches the
  blob (with retries), **decrypts AES-GCM natively**, and returns the
  bytes, so images work offline and load fast.
- **Insertion**: the toolbar image button opens the Capacitor Camera picker
  (1000 px max width, 80 % quality, popover on iPad); photos round-trip
  through base64 into `editor.uploadImages()`.
- **Preview**: tapping an image opens a native full-screen viewer (Agrume)
  via the ImagePreview plugin.

## What changes in v2, and why

- **Assets are normal files** under `assets/` with relative links, synced
  by git. No encryption, asset host, cache, or scheme decryption: the file
  *is* the offline copy. Plan 19 step 7 covers rendering through the same
  asset protocol as desktop.
- **No race protocol**: one writer (the app), one filesystem.
- **Photo insertion returns with editor/toolbar work**: picker → file in
  `assets/` → relative link at the caret, through the shared asset-write
  path (which emits its file-change batch like every local write). Keep
  V1's down-scaling (1000 px/80 %) as the mobile default: camera originals
  are huge, and graph size is sync cost.
- **Full-screen preview** becomes a webview lightbox when needed.
- V1's 50 MB cap maps to the product-vision guardrail: warnings/limits for
  large binaries in GitHub-backed graphs.

## V1 → v2 mapping

| V1                                              | v2                                                          |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Encrypted upload to asset host                  | Plain file write into `assets/`                              |
| Native encrypted cache + `reflect-assets://`    | The file on disk, served via the asset protocol              |
| reserve/add/get upload race protocol            | Gone — one writer, one filesystem                            |
| Camera picker → base64 → upload pipeline        | Picker → downscale → `assets/` file → relative link          |
| Agrume native full-screen preview               | Webview lightbox, later                                      |
| 50 MB cap                                       | Large-binary sync guardrails (product vision)                |
