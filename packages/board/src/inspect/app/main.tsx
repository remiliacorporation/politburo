import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { installButtonFeedback } from './button-feedback.ts'

const root = document.getElementById('root')!
installButtonFeedback(document)
createRoot(root).render(<App />)
