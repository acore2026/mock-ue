import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/v1': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:9070',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
