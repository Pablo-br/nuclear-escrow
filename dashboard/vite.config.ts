import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/state':     { target: 'http://localhost:3001', changeOrigin: true },
      '/milestone': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
