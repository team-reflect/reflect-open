import type { ReactElement } from 'react'

interface ChevronRightIconProps {
  className?: string
}

/** V1's right chevron — a 24×24 currentColor fill. */
export function ChevronRightIcon({ className }: ChevronRightIconProps): ReactElement {
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
        d="M10.2004 8.23966C9.91855 8.5432 9.93613 9.01775 10.2397 9.2996L13.1478 12L10.2397 14.7004C9.93613 14.9823 9.91855 15.4568 10.2004 15.7603C10.4823 16.0639 10.9568 16.0815 11.2603 15.7996L14.7603 12.5496C14.9132 12.4077 15 12.2086 15 12C15 11.7915 14.9132 11.5923 14.7603 11.4504L11.2603 8.20041C10.9568 7.91856 10.4823 7.93613 10.2004 8.23966Z"
        fill="currentColor"
      />
    </svg>
  )
}
