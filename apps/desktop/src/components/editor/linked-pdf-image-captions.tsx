import { useMemo, type ReactElement } from 'react'
import { definePlugin } from '@prosekit/core'
import { Plugin, PluginKey } from '@prosekit/pm/state'
import { Decoration, DecorationSet } from '@prosekit/pm/view'
import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import { useExtension } from '@meowdown/react'
import { linkedPdfImageCaption } from '@/lib/annotations/linked-pdf-image'
import { parsePdfHref, type PdfLinkRef } from '@/lib/annotations/pdf-href'

const CAPTION_CLASS = 'reflect-linked-pdf-caption'

function captionElement(ref: PdfLinkRef): HTMLElement {
  const element = document.createElement('span')
  element.className = CAPTION_CLASS
  element.contentEditable = 'false'
  element.textContent = linkedPdfImageCaption(ref)
  return element
}

/**
 * One caption widget per linked PDF image (`[![…](img)](assets/….pdf#page=N)`
 * — the annotation screenshot reference): a text node carrying both the
 * `mdImage` and `mdLinkText` marks, with the link's href naming a PDF page.
 * The widget sits right after the image source, inside the link's chip, so it
 * renders under the image exactly like a text reference's visible label.
 */
function captionDecorations(doc: ProseMirrorNode): Decoration[] {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) {
      return true
    }
    const linkMark = node.marks.find((mark) => mark.type.name === 'mdLinkText')
    const hasImage = node.marks.some((mark) => mark.type.name === 'mdImage')
    if (linkMark === undefined || !hasImage) {
      return false
    }
    const ref = parsePdfHref(String(linkMark.attrs['href'] ?? ''))
    if (ref === null) {
      return false
    }
    decorations.push(
      Decoration.widget(pos + node.nodeSize, () => captionElement(ref), {
        side: 1,
        ignoreSelection: true,
        key: `linked-pdf-caption-${pos}`,
      }),
    )
    return false
  })
  return decorations
}

const captionPluginKey = new PluginKey<DecorationSet>('reflect-linked-pdf-captions')

function createCaptionPlugin(): Plugin {
  return new Plugin({
    key: captionPluginKey,
    state: {
      init: (_config, state) => DecorationSet.create(state.doc, captionDecorations(state.doc)),
      apply: (tr, set, _oldState, newState) => {
        const mapped = set.map(tr.mapping, tr.doc)
        return tr.docChanged
          ? DecorationSet.create(newState.doc, captionDecorations(newState.doc))
          : mapped
      },
    },
    props: {
      decorations(state) {
        return captionPluginKey.getState(state)
      },
    },
  })
}

/**
 * Shows each linked PDF image chip's jump target (the PDF and page — the role
 * the label plays for a text reference) as a caption under the chip's image.
 *
 * The captions are ProseMirror widget decorations, NOT foreign DOM or portals:
 * the editor owns its contenteditable tree and re-renders outside mutations,
 * which the resulting observer ping-pong once turned into an infinite
 * re-render loop. Widgets are managed by ProseMirror itself. One wrinkle: the
 * inline widget nests inside the following source mark's wrapper (`.md-mark`),
 * which hide/focus mode suppresses with `opacity: 0` — the stylesheet lifts
 * the opacity on the wrapper holding a caption, or the caption would take up
 * layout space without ever painting.
 */
export function LinkedPdfImageCaptions(): ReactElement | null {
  const extension = useMemo(() => definePlugin(createCaptionPlugin()), [])
  useExtension(extension)
  return null
}
