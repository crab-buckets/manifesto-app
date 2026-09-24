import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.glb'], // Lanyard card model
  server: { proxy: { '/api': 'http://localhost:3000' } }, // dev: forward API calls to the Express server
})
