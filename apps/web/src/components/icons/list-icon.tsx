import type { ReactElement } from 'react'

interface ListIconProps {
  className?: string
}

/** V1's "All notes" glyph — a 24×24 currentColor fill. */
export function ListIcon({ className }: ListIconProps): ReactElement {
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
        d="M7.75 5C6.23122 5 5 6.23122 5 7.75V16.25C5 17.7688 6.23122 19 7.75 19H16.25C17.7688 19 19 17.7688 19 16.25V9.75C19 7.12665 16.8734 5 14.25 5H7.75ZM6.5 7.75C6.5 7.05964 7.05964 6.5 7.75 6.5H10.75C11.4404 6.5 12 7.05964 12 7.75V9.25C12 10.7688 13.2312 12 14.75 12H16.25C16.9404 12 17.5 12.5596 17.5 13.25V16.25C17.5 16.9404 16.9404 17.5 16.25 17.5H7.75C7.05964 17.5 6.5 16.9404 6.5 16.25V7.75Z"
        fill="currentColor"
      />
    </svg>
  )
}
