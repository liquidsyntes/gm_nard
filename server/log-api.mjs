import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultDirectory = fileURLToPath(new URL('../logs/', import.meta.url))
const logDirectory = process.env.GAME_LOG_DIR || defaultDirectory
const allowedKinds = new Set(['system', 'roll', 'move', 'cube', 'result'])
let writeQueue = Promise.resolve()

function reply(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function validEvent(value) {
  return value !== null && typeof value === 'object'
    && typeof value.session === 'string' && /^[a-f0-9]{32}$/.test(value.session)
    && Number.isInteger(value.game) && value.game >= 1 && value.game <= 1_000_000
    && allowedKinds.has(value.kind)
    && typeof value.text === 'string' && value.text.length > 0 && value.text.length <= 300
}

export async function appendGameEvent(value) {
  const at = new Date().toISOString()
  const path = join(logDirectory, `game-events-${at.slice(0, 10)}.jsonl`)
  const line = JSON.stringify({ at, session: value.session, game: value.game, kind: value.kind, text: value.text }) + '\n'
  const task = writeQueue.then(async () => {
    await mkdir(logDirectory, { recursive: true })
    await appendFile(path, line, 'utf8')
  })
  writeQueue = task.catch(() => {})
  await task
}

export async function handleLogRequest(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    reply(response, 405, { error: 'Method not allowed' })
    return
  }
  if (!request.headers['content-type']?.startsWith('application/json')) {
    reply(response, 415, { error: 'JSON required' })
    return
  }

  try {
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 4096) { reply(response, 413, { error: 'Event too large' }); return }
      chunks.push(chunk)
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!validEvent(value)) { reply(response, 400, { error: 'Invalid event' }); return }
    await appendGameEvent(value)
    reply(response, 201, { saved: true })
  } catch (error) {
    if (error instanceof SyntaxError) reply(response, 400, { error: 'Invalid JSON' })
    else reply(response, 500, { error: 'Could not write game log' })
  }
}
