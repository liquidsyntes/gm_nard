/// <reference types="node" />
import { defineConfig } from 'vite'
import { createMultiplayerApi } from './server/multiplayer.mjs'

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  build: { rollupOptions: { input: { game: 'index.html', online: 'online.html' } } },
  plugins: [{
    name: 'local-game-log-api',
    async configureServer(server) {
      const api = await createMultiplayerApi()
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith('/api/')) { next(); return }
        void api(request, response)
      })
    },
  }],
})
