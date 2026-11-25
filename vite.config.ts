/// <reference types="node" />
import { defineConfig } from 'vite'
import { createMultiplayerApi } from './server/multiplayer.mjs'

const rawBase = process.env.VITE_BASE || '/'
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

export default defineConfig({
  base,
  build: { rollupOptions: { input: { game: 'index.html', online: 'online.html' } } },
  plugins: [{
    name: 'local-game-log-api',
    async configureServer(server) {
      const api = await createMultiplayerApi()
      server.middlewares.use((request, response, next) => {
        const url = request.url || ''
        if (base !== '/' && url.startsWith(`${base}api/`)) {
          request.url = url.slice(base.length - 1)
        } else if (!url.startsWith('/api/')) {
          next()
          return
        }
        void api(request, response)
      })
    },
  }],
})
