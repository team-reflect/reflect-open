import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AnnotationItem } from './annotations-store'

/**
 * 归一化矩形（0~1，display 坐标：左上原点、y 向下，与标注 rects 同一空间）
 * 是否与另一个有正面积交集。
 */
function overlaps(a: readonly number[], b: readonly number[]): boolean {
  const overlapX = Math.min(a[2] ?? 0, b[2] ?? 0) - Math.max(a[0] ?? 0, b[0] ?? 0)
  const overlapY = Math.min(a[3] ?? 0, b[3] ?? 0) - Math.max(a[1] ?? 0, b[1] ?? 0)
  return overlapX > 0 && overlapY > 0
}

/**
 * 从 border 标注矩形覆盖的区域提取 PDF 文本：读取该页文本层，把每个文本项
 * 的 bbox 换算到与标注相同的归一化 display 坐标（PDF 用户空间 → viewport，
 * y 轴翻转，与 highlight-layer 一致），与标注矩形求交；命中项按阅读顺序拼接。
 *
 * 坐标换算：文本项 transform 是 `[a, b, c, d, e, f]`，基线起点在 PDF 用户
 * 空间 (e, f)，沿 x 延伸 `width`、字体高度 `height`（PDF y 轴向上），因此
 * bbox = `[e, f, e + width, f + height]`；`convertToViewportRectangle` 转到
 * display 像素后除以 viewport 尺寸即得 0~1 归一化值（与缩放无关）。
 *
 * 无命中或读取失败返回 null（调用方决定状态栏提示）。
 */
export async function extractRegionText(
  doc: PDFDocumentProxy,
  item: AnnotationItem,
): Promise<string | null> {
  const rect = item.rects[0]
  if (rect === undefined) {
    return null
  }
  let page
  try {
    page = await doc.getPage(item.pageIndex + 1)
  } catch {
    return null
  }
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  const matched: string[] = []
  for (const textItem of content.items) {
    // 文本层混有 markedContent 节点（无 str），用 `in` 收窄到 TextItem。
    if (!('str' in textItem) || textItem.str === '') {
      continue
    }
    const [, , , , e, f] = textItem.transform
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle([
      e,
      f,
      e + textItem.width,
      f + textItem.height,
    ])
    const normalized = [
      x1 / viewport.width,
      y1 / viewport.height,
      x2 / viewport.width,
      y2 / viewport.height,
    ]
    if (overlaps(rect, normalized)) {
      matched.push(textItem.str + (textItem.hasEOL === true ? '\n' : ''))
    }
  }
  // join 在换行项后补的空格会落到 '\n' 之后，折叠成干净的换行。
  const text = matched.join(' ').replaceAll('\n ', '\n').trim()
  return text === '' ? null : text
}
