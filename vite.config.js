import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:3000' } }, // dev: forward API calls to the Express server
  build: { sourcemap: false }, // don't ship source maps to production
})
