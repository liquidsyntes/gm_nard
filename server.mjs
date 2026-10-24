import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleLogRequest } from './server/log-api.mjs'

const projectDirectory = fileURLToPath(new URL('.', import.meta.url))
const staticDirectory = resolve(projectDirectory, 'dist')
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (request, response) => {
  let pathname
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) }
  catch { response.writeHead(400).end(); return }
  if (pathname === '/api/logs') { await handleLogRequest(request, response); return }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return }

  const file = resolve(staticDirectory, pathname === '/' ? 'index.html' : `.${pathname}`)
  if (!file.startsWith(`${staticDirectory}${sep}`)) { response.writeHead(403).end(); return }
  try {
    const body = await readFile(file)
    const extension = file.slice(file.lastIndexOf('.'))
    response.writeHead(200, { 'Content-Type': contentTypes[extension] ?? 'application/octet-stream' })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    response.writeHead(404).end()
  }
})

const port = Number(process.env.PORT || 4173)
server.listen(port, '127.0.0.1', () => console.log(`NARD: http://127.0.0.1:${port}/`))
