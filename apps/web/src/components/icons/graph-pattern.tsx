import type { ReactElement } from 'react'

/**
 * A piece of the Reflect brand graph, drawn in `currentColor`, whose edges run
 * past the view box.
 */
export function GraphPattern({ className }: { className?: string }): ReactElement {
  return (
    <svg aria-hidden viewBox="0 0 140 120" overflow="visible" fill="none" className={className}>
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round">
        <path d="M24 30 L66 18 L112 36 L94 78 L52 70 Z" />
        <path d="M66 18 L52 70 M112 36 L150 14 M94 78 L150 108 M52 70 L36 130 M24 30 L-10 58 M66 18 L74 -10" />
      </g>
      <g fill="currentColor">
        <circle cx="66" cy="18" r="4" />
        <circle cx="112" cy="36" r="5" />
        <circle cx="94" cy="78" r="3.5" />
        <circle cx="52" cy="70" r="4.5" />
        <circle cx="24" cy="30" r="3" />
      </g>
    </svg>
  )
}
