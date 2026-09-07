import { createRoot } from 'react-dom/client'
import { CaptureOptions } from './app'
import '../popup/style.css'

if (window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.add('dark')
document.body.style.width = 'auto'
const root = document.getElementById('root')
if (!root) throw new Error('settings root element missing')
createRoot(root).render(<CaptureOptions />)
