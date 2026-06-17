import { useMemo } from 'react'
import { defineClickHandler } from '@prosekit/core'
import { useExtension } from '@meowdown/react'

interface ImageClickExtensionProps {
  onImageClick: (image: HTMLImageElement) => void
}

function isPrimaryUnmodifiedClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  )
}

function getClickedMarkdownImage(event: MouseEvent): HTMLImageElement | null {
  const target = event.target
  if (!(target instanceof Element)) {
    return null
  }

  const image = target.closest('img')
  if (!(image instanceof HTMLImageElement) || image.closest('.md-image') === null) {
    return null
  }

  return image
}

export function ImageClickExtension({ onImageClick }: ImageClickExtensionProps): null {
  const extension = useMemo(
    () =>
      defineClickHandler((_view, _pos, event) => {
        if (!isPrimaryUnmodifiedClick(event)) {
          return false
        }

        const image = getClickedMarkdownImage(event)
        if (image === null) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()
        onImageClick(image)
        return true
      }),
    [onImageClick],
  )

  useExtension(extension)
  return null
}
