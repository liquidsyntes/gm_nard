import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultDirectory = fileURLToPath(new URL('../data/', import.meta.url))
const directory = process.env.GAME_DATA_DIR || defaultDirectory
const path = join(directory, 'state.json')

export async function createStore() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let state
  try { state = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    state = { version: 1, users: [], sessions: [], invites: [], games: [] }
    await writeFile(path, JSON.stringify(state, null, 2), { mode: 0o600 })
  }
  if (state.version !== 1 || !Array.isArray(state.users) || !Array.isArray(state.sessions) || !Array.isArray(state.invites) || !Array.isArray(state.games)) {
    throw new Error('Unsupported game data format')
  }

  let queue = Promise.resolve()
  const read = () => structuredClone(state)
  const transact = operation => {
    const task = queue.then(async () => {
      const draft = structuredClone(state)
      const result = operation(draft)
      const temporary = join(directory, `.state-${randomBytes(8).toString('hex')}.tmp`)
      await writeFile(temporary, JSON.stringify(draft, null, 2), { mode: 0o600 })
      await rename(temporary, path)
      state = draft
      return result
    })
    queue = task.catch(() => {})
    return task
  }
  return { read, transact }
}
