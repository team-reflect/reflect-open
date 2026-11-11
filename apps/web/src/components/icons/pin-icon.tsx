import type { ReactElement } from 'react'

interface PinIconProps {
  className?: string
  width?: number
  height?: number
}

/** V1's pin glyph — a 24×24 currentColor fill, size-overridable. */
export function PinIcon({ className, width, height }: PinIconProps): ReactElement {
  return (
    <svg
      width={width ?? 24}
      height={height ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M14.7983 7.78913C14.4128 7.40362 13.7877 7.40362 13.4022 7.78913L11.3891 9.80226C11.313 9.8784 11.2213 9.93726 11.1204 9.97482L8.10618 11.0967L12.9033 15.8938L14.0252 12.8796C14.0628 12.7787 14.1216 12.687 14.1978 12.6109L16.2109 10.5978C16.5964 10.2123 16.5964 9.58724 16.2109 9.20173L14.7983 7.78913ZM12.3416 6.72847C13.3129 5.75718 14.8877 5.75718 15.8589 6.72847L17.2715 8.14107C18.2428 9.11236 18.2428 10.6871 17.2715 11.6584L15.374 13.556L13.9017 17.5116C13.8127 17.7509 13.608 17.9284 13.3585 17.9828C13.1091 18.0372 12.8491 17.9609 12.6685 17.7803L9.97443 15.0862L7.28034 17.7803C6.98745 18.0732 6.51258 18.0732 6.21968 17.7803C5.92679 17.4874 5.92679 17.0126 6.21968 16.7197L8.91377 14.0256L6.21968 11.3315C6.03914 11.151 5.96285 10.891 6.01721 10.6415C6.07157 10.392 6.24911 10.1873 6.4884 10.0983L10.444 8.62604L12.3416 6.72847Z"
        fill="currentColor"
      />
    </svg>
  )
}
