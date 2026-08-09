import type { AnnotationItem } from './annotations-store'

/**
 * The markdown reference for one PDF annotation, matching the migration
 * product's PDF-link shape: `[<filename> - p<N> - <text>](assets/…pdf#page=N)`.
 * The `text` suffix drops when the annotation carries none. Pasting the link
 * into any note yields a clickable jump back to the PDF's page — the app's
 * `parsePdfHref` already resolves that href shape.
 */
export function annotationReference(assetPath: string, item: AnnotationItem): string {
  const filename =
    assetPath
      .split('/')
      .pop()
      ?.replace(/\.pdf$/i, '') ?? assetPath
  const page = item.pageIndex + 1
  // 文本折叠空白（多行/连续空格会破坏单行链接标签）。
  const text = item.text.trim().replaceAll(/\s+/g, ' ')
  const rawTitle = text === '' ? `${filename} - p${page}` : `${filename} - p${page} - ${text}`
  // 标签里的 markdown 特殊字符（[ ] \）转义一次，避免截断链接标签。
  const title = rawTitle.replaceAll(/[\\[\]]/g, (c) => `\\${c}`)
  // 路径必须 URL 编码（与迁移链接一致：空格 %20、中文 percent-encoded）——
  // markdown 链接目标含空格会解析失败、渲染成纯文本；parsePdfHref 点击时
  // 解码回原始路径再读取文件。
  return `[${title}](${encodeURI(assetPath)}#page=${page})`
}
