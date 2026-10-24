import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMultiplayerApi } from './server/multiplayer.mjs'
import { publicOrigin } from './server/auth.mjs'

const projectDirectory = fileURLToPath(new URL('.', import.meta.url))
const staticDirectory = resolve(projectDirectory, 'dist')
if (process.env.NODE_ENV === 'production' && !publicOrigin) throw new Error('PUBLIC_ORIGIN is required in production')
const api = await createMultiplayerApi()
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'")
  let pathname
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) }
  catch { response.writeHead(400).end(); return }
  if (pathname.startsWith('/api/')) { await api(request, response); return }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }

  const file = resolve(staticDirectory, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!file.startsWith(`${staticDirectory}${sep}`)) { response.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    const extension = file.slice(file.lastIndexOf('.'))
    if (extension === '.html') response.setHeader('Cache-Control', 'no-store')
    response.writeHead(200, { 'Content-Type': contentTypes[extension] ?? 'application/octet-stream' })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    response.writeHead(404).end()
  }
})

const port = Number(process.env.PORT || 4173)
const host = process.env.GAME_BIND_HOST || '127.0.0.1'
server.listen(port, host, () => console.log(`NARD: http://${host}:${port}/`))
