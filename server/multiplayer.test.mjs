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
  process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:7000'
  const { createStore } = await import('./store.mjs')
  const { newId, newToken, tokenHash } = await import('./auth.mjs')
  const { createMultiplayerApi } = await import('./multiplayer.mjs')
  const { legalSequences } = await import('./generated/engine.js')
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
    assert.equal((await call('/api/logs', null, { session: 'c'.repeat(32), game: 1, kind: 'system', text: 'Локальная проверка' })).status, 201)
    assert.equal((await call('/api/auth/login', null, { token: 'wrong' })).status, 401)
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) })).status, 403)
    assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: 'http://localhost:7000', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) })).status, 200)
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
    const cookieFor = (gameObj, side, curBobCookie = bobCookie) => gameObj.players[side] === alice.user.id ? aliceCookie : curBobCookie
    assert.equal((await call('/api/admin/users', aliceCookie, null, 'GET')).status, 403)
    for (const cookie of [aliceCookie, bobCookie]) {
      const stream = await call('/api/live', cookie, null, 'GET')
      assert.equal(stream.status, 200)
      streams.push(stream)
    }
    const lobby = await (await call('/api/lobby', aliceCookie, null, 'GET')).json()
    assert.ok(lobby.online.some(user => user.id === bob.user.id))

    // Cancel outgoing invite
    const tempInvite = await (await call('/api/invites', aliceCookie, { to: bob.user.id, targetPoints: 5 })).json()
    assert.equal((await call(`/api/invites/${tempInvite.invite.id}/cancel`, aliceCookie, {})).status, 200)
    assert.equal((await call(`/api/invites/${tempInvite.invite.id}/accept`, bobCookie, {})).status, 409)

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
    assert.equal(game.lastRoll.kind, 'opening')
    assert.equal(game.lastRoll.player, game.turn)
    assert.deepEqual(game.lastRoll.dice, game.dice)
    assert.equal(game.lastTurn, null)
    const activeCookie = cookieFor(game, game.turn)
    const waitingCookie = cookieFor(game, game.turn === 'light' ? 'dark' : 'light')
    const waitingMove = await call(`/api/games/${gameId}/move`, waitingCookie, { ...game.legalMoves[0], version: game.version })
    assert.equal(waitingMove.status, 409)
    const activeGame = (await (await call(`/api/games/${gameId}`, activeCookie, null, 'GET')).json()).game
    const move = activeGame.legalMoves[0]
    const moved = await call(`/api/games/${gameId}/move`, activeCookie, { ...move, version: activeGame.version })
    assert.equal(moved.status, 200)
    const movedBody = await moved.json()
    assert.equal(movedBody.fileLogged, true)
    assert.equal(movedBody.game.lastTurn.player, activeGame.turn)
    assert.equal(movedBody.game.lastTurn.rollId, activeGame.lastRoll.id)
    assert.deepEqual(movedBody.game.lastTurn.moves, [move])
    assert.equal((await call(`/api/games/${gameId}/move`, activeCookie, { ...move, version: activeGame.version })).status, 409)
    const reopened = await createStore()
    assert.ok(reopened.read().games.some(saved => saved.id === gameId && saved.version > game.version))

    let current = (await (await call(`/api/games/${gameId}`, aliceCookie, null, 'GET')).json()).game
    let steps = 0
    let regularRollSeen = false
    while (current.phase !== 'over' && steps < 2000) {
      const cookie = cookieFor(current, current.turn)
      const active = (await (await call(`/api/games/${gameId}`, cookie, null, 'GET')).json()).game
      const action = active.phase === 'roll' ? 'roll' : 'move'
      const payload = action === 'move' ? { ...active.legalMoves[0], version: active.version } : { version: active.version }
      const response = await call(`/api/games/${gameId}/${action}`, cookie, payload)
      assert.equal(response.status, 200)
      current = (await response.json()).game
      if (action === 'roll') {
        regularRollSeen = true
        assert.equal(current.lastRoll.kind, 'turn')
        assert.equal(current.lastRoll.player, active.turn)
        assert.deepEqual(current.lastRoll.dice, current.dice)
      }
      steps++
    }
    assert.equal(current.phase, 'over', `game did not finish after ${steps} actions`)
    assert.equal(regularRollSeen, true)
    assert.ok(current.result.points >= 1)
    const logFiles = await readdir(join(directory, 'logs'))
    assert.ok((await readFile(join(directory, 'logs', logFiles[0]), 'utf8')).includes('"kind":"move"'))

    // Match to 5 points: batch /turn, Crawford rule, next game, rematch & stats
    const matchInvite = await (await call('/api/invites', aliceCookie, { to: bob.user.id, targetPoints: 5, colorMode: 'light' })).json()
    const matchId = (await (await call(`/api/invites/${matchInvite.invite.id}/accept`, bobCookie, {})).json()).gameId
    let match = (await (await call(`/api/games/${matchId}`, aliceCookie, null, 'GET')).json()).game
    assert.equal(match.targetPoints, 5)
    assert.equal(match.players.light, alice.user.id)
    assert.equal(match.crawford, 'none')

    // Reject incomplete batch turn, then submit full legal sequence via /turn
    const starterCookie = cookieFor(match, match.turn)
    const sequences = legalSequences(match.board, match.turn, match.remaining)
    assert.ok(sequences.length > 0)
    assert.equal((await call(`/api/games/${matchId}/turn`, starterCookie, { version: match.version, moves: [sequences[0][0]] })).status, 400)
    const turnDone = await call(`/api/games/${matchId}/turn`, starterCookie, { version: match.version, moves: sequences[0] })
    assert.equal(turnDone.status, 200)
    match = (await turnDone.json()).game
    assert.equal(match.phase, 'roll')
    assert.deepEqual(match.lastTurn.moves, sequences[0])

    // Double to x2, accept, then opponent doubles to x4? Let's score 4 points via two x2 game resigns to trigger Crawford (4:0 in 5-pt match)
    const doubler1 = cookieFor(match, match.turn)
    const responder1 = cookieFor(match, match.turn === 'light' ? 'dark' : 'light')
    match = (await (await call(`/api/games/${matchId}/double`, doubler1, { version: match.version })).json()).game
    assert.equal(match.phase, 'offer')
    match = (await (await call(`/api/games/${matchId}/respond`, responder1, { version: match.version, accept: true })).json()).game
    assert.equal(match.cubeValue, 2)
    // responder1 (who accepted x2) resigns game -> doubler1 gets 2 points -> phase 'game_over'
    match = (await (await call(`/api/games/${matchId}/resign`, responder1, { version: match.version, scope: 'game' })).json()).game
    assert.equal(match.phase, 'game_over')
    assert.equal(Math.max(match.score.light, match.score.dark), 2)

    // Both players click next -> Game 2 starts
    match = (await (await call(`/api/games/${matchId}/next`, aliceCookie, { version: match.version })).json()).game
    assert.equal(match.phase, 'game_over')
    assert.equal(match.readyNext.length, 1)
    match = (await (await call(`/api/games/${matchId}/next`, bobCookie, { version: match.version })).json()).game
    assert.equal(match.phase, 'move')
    assert.equal(match.gameNumber, 2)
    assert.equal(match.crawford, 'none')

    // Finish game 2 opening turn, then double x2 and resign game in favor of the same leader to reach 4:0
    const leaderSide = match.score.light === 2 ? 'light' : 'dark'
    const trailerSide = leaderSide === 'light' ? 'dark' : 'light'
    while (match.phase === 'move') {
      const c = cookieFor(match, match.turn)
      const seq = legalSequences(match.board, match.turn, match.remaining)[0]
      match = (await (await call(`/api/games/${matchId}/turn`, c, { version: match.version, moves: seq })).json()).game
    }
    // If trailer has the roll, let trailer roll & play once so leader gets roll, or double from whoever has roll
    if (match.turn !== leaderSide) {
      match = (await (await call(`/api/games/${matchId}/double`, cookieFor(match, trailerSide), { version: match.version })).json()).game
      match = (await (await call(`/api/games/${matchId}/respond`, cookieFor(match, leaderSide), { version: match.version, accept: true })).json()).game
    } else {
      match = (await (await call(`/api/games/${matchId}/double`, cookieFor(match, leaderSide), { version: match.version })).json()).game
      match = (await (await call(`/api/games/${matchId}/respond`, cookieFor(match, trailerSide), { version: match.version, accept: true })).json()).game
    }
    assert.equal(match.cubeValue, 2)
    match = (await (await call(`/api/games/${matchId}/resign`, cookieFor(match, trailerSide), { version: match.version, scope: 'game' })).json()).game
    assert.equal(match.phase, 'game_over')
    assert.equal(match.score[leaderSide], 4)

    // Advance to Game 3 -> Crawford game!
    match = (await (await call(`/api/games/${matchId}/next`, aliceCookie, { version: match.version })).json()).game
    match = (await (await call(`/api/games/${matchId}/next`, bobCookie, { version: match.version })).json()).game
    assert.equal(match.gameNumber, 3)
    assert.equal(match.crawford, 'active')
    const seq3 = legalSequences(match.board, match.turn, match.remaining)[0]
    match = (await (await call(`/api/games/${matchId}/turn`, cookieFor(match, match.turn), { version: match.version, moves: seq3 })).json()).game
    // Doubling must be forbidden in Crawford game
    assert.equal((await call(`/api/games/${matchId}/double`, cookieFor(match, match.turn), { version: match.version })).status, 409)
    // Finish match by resigning whole match
    match = (await (await call(`/api/games/${matchId}/resign`, cookieFor(match, trailerSide), { version: match.version })).json()).game
    assert.equal(match.phase, 'over')
    assert.equal(match.result.winner, leaderSide)
    assert.equal(match.score[leaderSide], 5)

    // Verify stats in lobby and rematch invite visibility on finished game
    const statsLobby = await (await call('/api/lobby', aliceCookie, null, 'GET')).json()
    assert.equal(statsLobby.stats.played, 2)
    assert.equal(statsLobby.stats.wins + statsLobby.stats.losses, 2)
    assert.ok(statsLobby.stats.headToHead[bob.user.id])

    const rematchInvite = await (await call('/api/invites', aliceCookie, { to: bob.user.id, targetPoints: 5 })).json()
    const finishedView = (await (await call(`/api/games/${matchId}`, bobCookie, null, 'GET')).json()).game
    assert.equal(finishedView.rematchInvite.id, rematchInvite.invite.id)
    assert.equal(finishedView.rematchInvite.direction, 'incoming')
    assert.equal(finishedView.opponentOnline, true)
    assert.equal((await call(`/api/invites/${rematchInvite.invite.id}/cancel`, aliceCookie, {})).status, 200)

    // Timeout claim test (set GAME_INACTIVITY_MINUTES to ~60ms)
    process.env.GAME_INACTIVITY_MINUTES = '0.001'
    const timeoutInvite = await (await call('/api/invites', aliceCookie, { to: bob.user.id })).json()
    const timeoutId = (await (await call(`/api/invites/${timeoutInvite.invite.id}/accept`, bobCookie, {})).json()).gameId
    const timeoutGame = (await (await call(`/api/games/${timeoutId}`, aliceCookie, null, 'GET')).json()).game
    const activeTimeoutCookie = cookieFor(timeoutGame, timeoutGame.turn)
    const waitingTimeoutCookie = cookieFor(timeoutGame, timeoutGame.turn === 'light' ? 'dark' : 'light')
    assert.equal((await call(`/api/games/${timeoutId}/claim-timeout`, activeTimeoutCookie, { version: timeoutGame.version })).status, 409)
    await new Promise(resolve => setTimeout(resolve, 90))
    const claimed = await call(`/api/games/${timeoutId}/claim-timeout`, waitingTimeoutCookie, { version: timeoutGame.version })
    assert.equal(claimed.status, 200)
    const claimedGame = (await claimed.json()).game
    assert.equal(claimedGame.phase, 'over')
    assert.equal(claimedGame.result.kind, 'timeout')
    delete process.env.GAME_INACTIVITY_MINUTES

    // Rotate token and disable account forfeit
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
    assert.equal(forfeited.result.winner, forfeited.players.light === alice.user.id ? 'light' : 'dark')
    assert.equal(forfeited.result.kind, 'forfeit')
    assert.equal((await call('/api/auth/me', freshBobCookie, null, 'GET')).status, 401)
    assert.equal((await call('/api/auth/login', null, { token: replacement.token })).status, 401)
  } finally {
    delete process.env.GAME_INACTIVITY_MINUTES
    for (const stream of streams) await stream.body.cancel()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
