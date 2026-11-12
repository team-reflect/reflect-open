import type { ReactElement } from 'react'

interface ArrowUturnLeftIconProps {
  className?: string
  width?: number
  height?: number
}

/**
 * The return-arrow on similar-note rows (heroicons 24/outline
 * `ArrowUturnLeft`, inlined — V2 carries no heroicons dependency). V1 renders
 * it horizontally flipped; wrap in a `-scale-x-100` span at the call site.
 */
export function ArrowUturnLeftIcon({
  className,
  width,
  height,
}: ArrowUturnLeftIconProps): ReactElement {
  return (
    <svg
      width={width ?? 24}
      height={height ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3"
      />
    </svg>
  )
}
