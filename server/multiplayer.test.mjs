import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('admin tokens, online invitation and server-validated moves survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nard-online-test-'))
  process.env.GAME_DATA_DIR = join(directory, 'data')
  process.env.GAME_LOG_DIR = join(directory, 'logs')
  const { createStore } = await import('./store.mjs')
  const { newId, newToken, tokenHash } = await import('./auth.mjs')
  const { createMultiplayerApi } = await import('./multiplayer.mjs')
  const store = await createStore()
  const adminToken = newToken()
  await store.transact(state => { state.users.push({ id: newId(), name: 'Админ', role: 'admin', tokenHash: tokenHash(adminToken), disabled: false, createdAt: new Date().toISOString() }) })
  const api = await createMultiplayerApi()
  const server = createServer((request, response) => { void api(request, response) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const streams = []
  const call = async (path, cookie, body, method = 'POST') => fetch(`${base}${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const login = async token => {
    const response = await call('/api/auth/login', null, { token })
    assert.equal(response.status, 200)
    return response.headers.get('set-cookie').split(';')[0]
  }

  try {
    assert.equal((await call('/api/auth/login', null, { token: 'wrong' })).status, 401)
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) })).status, 403)
    const adminCookie = await login(adminToken)
    const aliceCreated = await call('/api/admin/users', adminCookie, { name: 'Алиса' })
    const bobCreated = await call('/api/admin/users', adminCookie, { name: 'Борис' })
    assert.equal(aliceCreated.status, 201)
    assert.equal(bobCreated.status, 201)
    const alice = await aliceCreated.json()
    const bob = await bobCreated.json()
    const stateText = await readFile(join(directory, 'data', 'state.json'), 'utf8')
    assert.equal(stateText.includes(alice.token), false)
    assert.equal(stateText.includes(bob.token), false)

    const aliceCookie = await login(alice.token)
    const bobCookie = await login(bob.token)
    assert.equal((await call('/api/admin/users', aliceCookie, null, 'GET')).status, 403)
    for (const cookie of [aliceCookie, bobCookie]) {
      const stream = await call('/api/live', cookie, null, 'GET')
      assert.equal(stream.status, 200)
      streams.push(stream)
    }
    const lobby = await (await call('/api/lobby', aliceCookie, null, 'GET')).json()
    assert.ok(lobby.online.some(user => user.id === bob.user.id))
    const inviteResponse = await call('/api/invites', aliceCookie, { to: bob.user.id })
    assert.equal(inviteResponse.status, 201)
    const invite = await inviteResponse.json()
    const accepted = await call(`/api/invites/${invite.invite.id}/accept`, bobCookie, {})
    assert.equal(accepted.status, 200)
    const { gameId, fileLogged } = await accepted.json()
    assert.equal(fileLogged, true)
    assert.equal((await call(`/api/games/${gameId}`, adminCookie, null, 'GET')).status, 404)

    const gameResponse = await call(`/api/games/${gameId}`, aliceCookie, null, 'GET')
    assert.equal(gameResponse.status, 200)
    const { game } = await gameResponse.json()
    const activeCookie = game.turn === 'light' ? aliceCookie : bobCookie
    const waitingCookie = game.turn === 'light' ? bobCookie : aliceCookie
    const waitingMove = await call(`/api/games/${gameId}/move`, waitingCookie, { ...game.legalMoves[0], version: game.version })
    assert.equal(waitingMove.status, 409)
    const activeGame = (await (await call(`/api/games/${gameId}`, activeCookie, null, 'GET')).json()).game
    const move = activeGame.legalMoves[0]
    const moved = await call(`/api/games/${gameId}/move`, activeCookie, { ...move, version: activeGame.version })
    assert.equal(moved.status, 200)
    assert.equal((await moved.json()).fileLogged, true)
    assert.equal((await call(`/api/games/${gameId}/move`, activeCookie, { ...move, version: activeGame.version })).status, 409)
    const reopened = await createStore()
    assert.ok(reopened.read().games.some(saved => saved.id === gameId && saved.version > game.version))

    let current = (await (await call(`/api/games/${gameId}`, aliceCookie, null, 'GET')).json()).game
    let steps = 0
    while (current.phase !== 'over' && steps < 2000) {
      const cookie = current.turn === 'light' ? aliceCookie : bobCookie
      const active = (await (await call(`/api/games/${gameId}`, cookie, null, 'GET')).json()).game
      const action = active.phase === 'roll' ? 'roll' : 'move'
      const payload = action === 'move' ? { ...active.legalMoves[0], version: active.version } : { version: active.version }
      const response = await call(`/api/games/${gameId}/${action}`, cookie, payload)
      assert.equal(response.status, 200)
      current = (await response.json()).game
      steps++
    }
    assert.equal(current.phase, 'over', `game did not finish after ${steps} actions`)
    assert.ok(current.result.points >= 1)
    const logFiles = await readdir(join(directory, 'logs'))
    assert.ok((await readFile(join(directory, 'logs', logFiles[0]), 'utf8')).includes('"kind":"move"'))

    const secondInvite = await call('/api/invites', aliceCookie, { to: bob.user.id })
    assert.equal(secondInvite.status, 201)
    const secondInviteId = (await secondInvite.json()).invite.id
    const secondId = (await (await call(`/api/invites/${secondInviteId}/accept`, bobCookie, {})).json()).gameId
    let second = (await (await call(`/api/games/${secondId}`, aliceCookie, null, 'GET')).json()).game
    while (second.phase === 'move') {
      const cookie = second.turn === 'light' ? aliceCookie : bobCookie
      const active = (await (await call(`/api/games/${secondId}`, cookie, null, 'GET')).json()).game
      second = (await (await call(`/api/games/${secondId}/move`, cookie, { ...active.legalMoves[0], version: active.version })).json()).game
    }
    const doubler = second.turn === 'light' ? aliceCookie : bobCookie
    const responder = second.turn === 'light' ? bobCookie : aliceCookie
    second = (await (await call(`/api/games/${secondId}/double`, doubler, { version: second.version })).json()).game
    assert.equal(second.phase, 'offer')
    second = (await (await call(`/api/games/${secondId}/respond`, responder, { version: second.version, accept: true })).json()).game
    assert.equal(second.cubeValue, 2)
    second = (await (await call(`/api/games/${secondId}/resign`, doubler, { version: second.version })).json()).game
    assert.equal(second.result.points, 2)

    const rotated = await call(`/api/admin/users/${bob.user.id}/rotate`, adminCookie, {})
    assert.equal(rotated.status, 200)
    const replacement = await rotated.json()
    assert.equal((await call('/api/auth/me', bobCookie, null, 'GET')).status, 401)
    assert.equal((await call('/api/auth/login', null, { token: bob.token })).status, 401)
    const freshBobCookie = await login(replacement.token)
    assert.ok(freshBobCookie.startsWith('nard_session='))
    const freshStream = await call('/api/live', freshBobCookie, null, 'GET')
    streams.push(freshStream)
    const thirdInvite = await call('/api/invites', aliceCookie, { to: bob.user.id })
    assert.equal(thirdInvite.status, 201)
    const thirdInviteId = (await thirdInvite.json()).invite.id
    const thirdId = (await (await call(`/api/invites/${thirdInviteId}/accept`, freshBobCookie, {})).json()).gameId
    assert.equal((await call(`/api/admin/users/${bob.user.id}/toggle`, adminCookie, {})).status, 200)
    const forfeited = (await (await call(`/api/games/${thirdId}`, aliceCookie, null, 'GET')).json()).game
    assert.equal(forfeited.phase, 'over')
    assert.equal(forfeited.result.winner, 'light')
    assert.equal(forfeited.result.kind, 'forfeit')
    assert.equal((await call('/api/auth/me', freshBobCookie, null, 'GET')).status, 401)
    assert.equal((await call('/api/auth/login', null, { token: replacement.token })).status, 401)
  } finally {
    for (const stream of streams) await stream.body.cancel()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
