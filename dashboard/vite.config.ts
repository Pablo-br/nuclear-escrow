import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/state':     { target: 'http://localhost:3001', changeOrigin: true, configure: (proxy) => { proxy.on('error', (err) => console.error('[proxy/state]', err.message)); } },
      '/milestone': { target: 'http://localhost:3001', changeOrigin: true },
      '/xrpl-rpc':  { target: 'http://localhost:3001', changeOrigin: true, configure: (proxy) => { proxy.on('error', (err) => console.error('[proxy/xrpl-rpc]', err.message)); } },
      '/audit':     { target: 'http://localhost:3001', changeOrigin: true },
      '/deploy':    { target: 'http://localhost:3001', changeOrigin: true },
      '/templates': { target: 'http://localhost:3001', changeOrigin: true },
      '/contracts': { target: 'http://localhost:3001', changeOrigin: true },
      '/ai':        { target: 'http://localhost:3001', changeOrigin: true },
      '/auth':      { target: 'http://localhost:3001', changeOrigin: true },
      '/xrpl':      { target: 'http://localhost:3001', changeOrigin: true },
      '/regulator': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
})
