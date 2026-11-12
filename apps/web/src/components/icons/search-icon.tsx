import type { ReactElement } from 'react'

interface SearchIconProps {
  className?: string
}

/** V1's search magnifier — a 24×24 currentColor stroke. */
export function SearchIcon({ className }: SearchIconProps): ReactElement {
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
        d="M13.8588 13.8588C14.7183 12.9992 15.25 11.8117 15.25 10.5C15.25 7.87665 13.1234 5.75 10.5 5.75C7.87665 5.75 5.75 7.87665 5.75 10.5C5.75 13.1234 7.87665 15.25 10.5 15.25C11.8117 15.25 12.9992 14.7183 13.8588 13.8588ZM13.8588 13.8588L18.5 18.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}
