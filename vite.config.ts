import { defineConfig } from 'vite'
import { handleLogRequest } from './server/log-api.mjs'

export default defineConfig({
  plugins: [{
    name: 'local-game-log-api',
    configureServer(server) {
      server.middlewares.use('/api/logs', (request, response) => {
        void handleLogRequest(request, response)
      })
    },
  }],
})
