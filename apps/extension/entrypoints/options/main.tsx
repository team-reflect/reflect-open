import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureOptions } from './app'
import './style.css'

if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.classList.add('dark')
}
const root = document.getElementById('root')
if (!root) throw new Error('options root element missing')
createRoot(root).render(<StrictMode><CaptureOptions /></StrictMode>)
