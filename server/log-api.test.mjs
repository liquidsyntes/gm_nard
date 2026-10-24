import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('valid game events are appended to a file and invalid events are rejected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nard-log-test-'))
  process.env.GAME_LOG_DIR = directory
  const { handleLogRequest } = await import('./log-api.mjs')
  const server = createServer(handleLogRequest)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  try {
    const event = { session: 'a'.repeat(32), game: 1, kind: 'move', text: 'Светлые: 13 → 8, кость 5.' }
    const saved = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
    assert.equal(saved.status, 201)
    const rejected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...event, kind: 'unknown' }) })
    assert.equal(rejected.status, 400)
    assert.equal((await fetch(url)).status, 405)

    const files = await readdir(directory)
    assert.equal(files.length, 1)
    const lines = (await readFile(join(directory, files[0]), 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1)
    const savedEvent = JSON.parse(lines[0])
    assert.match(savedEvent.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(savedEvent, { at: savedEvent.at, ...event })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
