import type { ReactElement } from 'react'

interface MicIconProps {
  className?: string
}

/** V1's microphone glyph — a 24×24 currentColor fill. */
export function MicIcon({ className }: MicIconProps): ReactElement {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.99976 8C7.99976 5.79086 9.79062 4 11.9998 4C14.2089 4 15.9998 5.79086 15.9998 8V10C15.9998 12.2091 14.2089 14 11.9998 14C9.79062 14 7.99976 12.2091 7.99976 10V8ZM11.9998 12.5C13.3805 12.5 14.4998 11.3807 14.4998 10V8C14.4998 6.61929 13.3805 5.5 11.9998 5.5C10.619 5.5 9.49976 6.61929 9.49976 8V10C9.49976 11.3807 10.619 12.5 11.9998 12.5Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M6.51254 12.0385C6.9055 11.9075 7.33024 12.1199 7.46123 12.5128C8.08813 14.3935 9.93737 15.5 11.9998 15.5C14.0621 15.5 15.9113 14.3935 16.5382 12.5128C16.6692 12.1199 17.0939 11.9075 17.4869 12.0385C17.8798 12.1695 18.0922 12.5942 17.9612 12.9872C17.1736 15.3502 15.0422 16.7156 12.7497 16.9601L12.7497 19.25C12.7497 19.6642 12.4139 20 11.9997 20C11.5855 20 11.2497 19.6642 11.2497 19.25L11.2497 16.9601C8.95729 16.7156 6.82588 15.3502 6.0382 12.9872C5.90722 12.5942 6.11959 12.1695 6.51254 12.0385Z"
        fill="currentColor"
      />
    </svg>
  )
}
