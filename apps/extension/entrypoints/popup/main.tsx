import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CapturePopup } from './app'
import './style.css'

// MV3 pages forbid inline scripts, so the design-system `.dark` scope is set
// here, before first paint of the React tree.
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark')
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('popup root element missing')
}
createRoot(rootElement).render(
  <StrictMode>
    <CapturePopup />
  </StrictMode>,
)
