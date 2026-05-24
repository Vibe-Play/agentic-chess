import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { gameServerPlugin } from './src/server/vite-plugin'

export default defineConfig({
  plugins: [react(), gameServerPlugin()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
