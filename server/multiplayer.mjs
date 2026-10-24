import { randomInt } from 'node:crypto'
import { appendGameEvent, handleLogRequest } from './log-api.mjs'
import { cookieToken, clearSessionCookie, newId, newSessionToken, newToken, publicOrigin, sessionCookie, SESSION_DAYS, tokenHash, tokenMatches } from './auth.mjs'
import { createStore } from './store.mjs'
import { applyMove, firstMoves, initialBoard, legalSequences, opponent, resultKind, resultPoints, sameMove } from './generated/engine.js'

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

const fail = (status, message) => { throw new ApiError(status, message) }
const publicUser = user => ({ id: user.id, name: user.name, role: user.role, disabled: user.disabled })
const playerColor = (game, userId) => game.players.light === userId ? 'light' : game.players.dark === userId ? 'dark' : null
const gameFor = (state, userId) => state.games.some(game => game.phase !== 'over' && playerColor(game, userId))
const now = () => new Date().toISOString()
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]']
const guestFileLogsAllowed = !publicOrigin || loopbackHosts.includes(new URL(publicOrigin).hostname)

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}

async function bodyJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) fail(415, 'Требуется JSON')
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 4096) fail(413, 'Запрос слишком большой')
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { fail(400, 'Некорректный JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Ожидается JSON-объект')
  return value
}

function nameValid(value) {
  return typeof value === 'string' && /^[\p{L}\p{N}_ -]{3,32}$/u.test(value.trim())
}

function originAllowed(request) {
  const origin = request.headers.origin
  const expected = publicOrigin || `http://${request.headers.host}`
  if (!origin || origin === expected) return true
  try {
    const actual = new URL(origin)
    const configured = new URL(expected)
    return loopbackHosts.includes(actual.hostname) && loopbackHosts.includes(configured.hostname)
      && actual.protocol === configured.protocol && actual.port === configured.port
  } catch { return false }
}

function currentUser(state, request) {
  const token = cookieToken(request)
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const digest = tokenHash(token)
  const session = state.sessions.find(item => item.hash === digest && Date.parse(item.expiresAt) > Date.now())
  if (!session) return null
  const user = state.users.find(item => item.id === session.userId && !item.disabled)
  return user ? { user, sessionHash: digest } : null
}

function assertSession(state, auth) {
  if (!state.sessions.some(item => item.hash === auth.sessionHash && item.userId === auth.user.id && Date.parse(item.expiresAt) > Date.now())) fail(401, 'Сессия завершена')
  if (!state.users.some(item => item.id === auth.user.id && !item.disabled)) fail(401, 'Аккаунт отключён')
}

function event(game, kind, text) {
  const entry = { at: now(), kind, text }
  game.events.push(entry)
  if (game.events.length > 200) game.events.shift()
  game.updatedAt = entry.at
  game.version++
  return entry
}

function visibleGame(game, userId) {
  const color = playerColor(game, userId)
  return {
    id: game.id,
    players: game.players,
    color,
    board: game.board,
    turn: game.turn,
    phase: game.phase,
    dice: game.dice,
    remaining: game.remaining,
    cubeValue: game.cubeValue,
    cubeOwner: game.cubeOwner,
    offerer: game.offerer,
    result: game.result,
    events: game.events,
    version: game.version,
    legalMoves: game.phase === 'move' && game.turn === color ? firstMoves(legalSequences(game.board, color, game.remaining)) : [],
  }
}

function gameById(state, id, userId) {
  const game = state.games.find(item => item.id === id)
  if (!game || !playerColor(game, userId)) fail(404, 'Партия не найдена')
  return game
}

function startGame(from, to) {
  let lightRoll = randomInt(1, 7)
  let darkRoll = randomInt(1, 7)
  while (lightRoll === darkRoll) { lightRoll = randomInt(1, 7); darkRoll = randomInt(1, 7) }
  const turn = lightRoll > darkRoll ? 'light' : 'dark'
  const game = {
    id: newId(), players: { light: from, dark: to }, board: initialBoard(), turn, phase: 'move',
    dice: [lightRoll, darkRoll], remaining: [lightRoll, darkRoll], cubeValue: 1,
    cubeOwner: null, offerer: null, result: null, events: [], version: 0, createdAt: now(), updatedAt: now(),
  }
  event(game, 'roll', `Первый бросок: светлые ${lightRoll}, тёмные ${darkRoll}. Начинают ${turn === 'light' ? 'светлые' : 'тёмные'}.`)
  return game
}

export async function createMultiplayerApi() {
  const store = await createStore()
  const live = new Map()
  const loginAttempts = new Map()

  const broadcast = () => {
    for (const clients of live.values()) for (const response of clients) {
      try { response.write('event: refresh\ndata: {}\n\n') } catch { clients.delete(response) }
    }
  }
  const dropConnections = userId => {
    for (const response of live.get(userId) || []) response.end()
    live.delete(userId)
  }
  const writeEvents = async (game, entries) => {
    let saved = true
    for (const entry of entries) {
      try { await appendGameEvent({ session: game.id, game: 1, kind: entry.kind, text: entry.text }) }
      catch (error) { saved = false; console.error('Game log write failed:', error.message) }
    }
    return saved
  }

  return async (request, response) => {
    let pathname
    try { pathname = new URL(request.url, 'http://localhost').pathname }
    catch { send(response, 400, { error: 'Некорректный адрес' }); return }
    try {
      if (request.method !== 'GET' && !originAllowed(request)) fail(403, 'Неверный источник запроса')
      if (pathname === '/api/health' && request.method === 'GET') { send(response, 200, { ok: true }); return }

      if (pathname === '/api/auth/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress || 'unknown'
        const recent = (loginAttempts.get(ip) || []).filter(time => time > Date.now() - 60_000)
        if (recent.length >= 30) fail(429, 'Слишком много попыток входа')
        recent.push(Date.now())
        loginAttempts.set(ip, recent)
        const body = await bodyJson(request)
        const state = store.read()
        const user = state.users.find(item => !item.disabled && tokenMatches(body.token, item.tokenHash))
        if (!user) fail(401, 'Неверный токен')
        const token = newSessionToken()
        await store.transact(draft => {
          draft.sessions = draft.sessions.filter(item => Date.parse(item.expiresAt) > Date.now())
          draft.sessions.push({ hash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString() })
        })
        send(response, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) })
        return
      }

      const auth = currentUser(store.read(), request)
      if (pathname === '/api/logs') {
        if (!guestFileLogsAllowed && !auth) fail(401, 'Требуется вход')
        await handleLogRequest(request, response)
        return
      }
      if (!auth) fail(401, 'Требуется вход')
      const user = auth.user

      if (pathname === '/api/auth/me' && request.method === 'GET') { send(response, 200, { user: publicUser(user) }); return }
      if (pathname === '/api/auth/logout' && request.method === 'POST') {
        await store.transact(state => { assertSession(state, auth); state.sessions = state.sessions.filter(item => item.hash !== auth.sessionHash) })
        send(response, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() })
        return
      }
      if (pathname === '/api/live' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
        response.write('event: ready\ndata: {}\n\n')
        if (!live.has(user.id)) live.set(user.id, new Set())
        live.get(user.id).add(response)
        broadcast()
        const heartbeat = setInterval(() => {
          if (!currentUser(store.read(), request)) response.end()
          else response.write(': ping\n\n')
        }, 20_000)
        request.on('close', () => {
          clearInterval(heartbeat)
          live.get(user.id)?.delete(response)
          if (live.get(user.id)?.size === 0) live.delete(user.id)
          broadcast()
        })
        return
      }

      if (pathname === '/api/lobby' && request.method === 'GET') {
        const state = store.read()
        const names = new Map(state.users.map(item => [item.id, item.name]))
        const pending = state.invites.filter(item => item.status === 'pending' && Date.parse(item.expiresAt) > Date.now())
        send(response, 200, {
          online: state.users.filter(item => item.id !== user.id && !item.disabled && live.has(item.id)).map(publicUser),
          incoming: pending.filter(item => item.to === user.id).map(item => ({ id: item.id, from: names.get(item.from), createdAt: item.createdAt })),
          outgoing: pending.filter(item => item.from === user.id).map(item => ({ id: item.id, to: names.get(item.to), createdAt: item.createdAt })),
          games: state.games.filter(item => playerColor(item, user.id)).slice(-30).reverse().map(item => ({ id: item.id, opponent: names.get(item.players.light === user.id ? item.players.dark : item.players.light), phase: item.phase, updatedAt: item.updatedAt, result: item.result })),
        })
        return
      }

      if (pathname === '/api/admin/users' && request.method === 'GET') {
        if (user.role !== 'admin') fail(403, 'Недостаточно прав')
        send(response, 200, { users: store.read().users.map(publicUser) })
        return
      }
      if (pathname === '/api/admin/users' && request.method === 'POST') {
        if (user.role !== 'admin') fail(403, 'Недостаточно прав')
        const body = await bodyJson(request)
        if (!nameValid(body.name)) fail(400, 'Имя: 3–32 символа, буквы, цифры, пробел, _ или -')
        const name = body.name.trim()
        const token = newToken()
        const created = await store.transact(state => {
          assertSession(state, auth)
          if (state.users.some(item => item.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) fail(409, 'Имя уже занято')
          const account = { id: newId(), name, role: 'player', tokenHash: tokenHash(token), disabled: false, createdAt: now() }
          state.users.push(account)
          return publicUser(account)
        })
        send(response, 201, { user: created, token })
        broadcast()
        return
      }
      const adminAction = pathname.match(/^\/api\/admin\/users\/([a-f0-9]{32})\/(rotate|toggle)$/)
      if (adminAction && request.method === 'POST') {
        if (user.role !== 'admin') fail(403, 'Недостаточно прав')
        const token = adminAction[2] === 'rotate' ? newToken() : null
        const changed = await store.transact(state => {
          assertSession(state, auth)
          const account = state.users.find(item => item.id === adminAction[1] && item.role === 'player')
          if (!account) fail(404, 'Пользователь не найден')
          if (token) { account.tokenHash = tokenHash(token); state.sessions = state.sessions.filter(item => item.userId !== account.id) }
          else { account.disabled = !account.disabled; if (account.disabled) state.sessions = state.sessions.filter(item => item.userId !== account.id) }
          const ended = []
          if (account.disabled) for (const game of state.games) {
            const color = playerColor(game, account.id)
            if (!color || game.phase === 'over') continue
            game.phase = 'over'
            game.offerer = null
            game.result = { winner: opponent(color), kind: 'forfeit', points: game.cubeValue }
            ended.push({ game, entry: event(game, 'result', `Аккаунт «${account.name}» отключён администратором. Партия завершена.`) })
          }
          return { account: publicUser(account), ended }
        })
        for (const item of changed.ended) await writeEvents(item.game, [item.entry])
        send(response, 200, { user: changed.account, ...(token ? { token } : {}) })
        if (token || changed.account.disabled) dropConnections(changed.account.id)
        broadcast()
        return
      }

      if (pathname === '/api/invites' && request.method === 'POST') {
        const body = await bodyJson(request)
        const target = body.to
        if (typeof target !== 'string' || !/^[a-f0-9]{32}$/.test(target) || target === user.id) fail(400, 'Некорректный адресат')
        const invite = await store.transact(state => {
          assertSession(state, auth)
          if (!state.users.some(item => item.id === target && !item.disabled) || !live.has(target)) fail(409, 'Игрок уже не в сети')
          if (gameFor(state, user.id) || gameFor(state, target)) fail(409, 'Один из игроков уже в партии')
          if (state.invites.some(item => item.status === 'pending' && item.from === user.id && item.to === target && Date.parse(item.expiresAt) > Date.now())) fail(409, 'Приглашение уже отправлено')
          const created = { id: newId(), from: user.id, to: target, status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }
          state.invites.push(created)
          return created
        })
        send(response, 201, { invite: { id: invite.id, expiresAt: invite.expiresAt } })
        broadcast()
        return
      }
      const inviteAction = pathname.match(/^\/api\/invites\/([a-f0-9]{32})\/(accept|decline)$/)
      if (inviteAction && request.method === 'POST') {
        const result = await store.transact(state => {
          assertSession(state, auth)
          const invite = state.invites.find(item => item.id === inviteAction[1] && item.to === user.id)
          if (!invite || invite.status !== 'pending' || Date.parse(invite.expiresAt) <= Date.now()) fail(409, 'Приглашение недоступно')
          if (inviteAction[2] === 'decline') { invite.status = 'declined'; return { game: null } }
          if (!live.has(invite.from) || !state.users.some(item => item.id === invite.from && !item.disabled)) fail(409, 'Отправитель уже не в сети')
          if (gameFor(state, invite.from) || gameFor(state, invite.to)) fail(409, 'Один из игроков уже в партии')
          const game = startGame(invite.from, invite.to)
          state.games.push(game)
          invite.status = 'accepted'
          invite.gameId = game.id
          return { game }
        })
        const fileLogged = result.game ? await writeEvents(result.game, result.game.events) : true
        send(response, 200, { gameId: result.game?.id ?? null, fileLogged })
        broadcast()
        return
      }

      const gameRoute = pathname.match(/^\/api\/games\/([a-f0-9]{32})(?:\/(roll|move|double|respond|resign))?$/)
      if (gameRoute) {
        const id = gameRoute[1]
        const action = gameRoute[2]
        if (!action && request.method === 'GET') {
          const state = store.read()
          const game = gameById(state, id, user.id)
          send(response, 200, { game: visibleGame(game, user.id), users: state.users.filter(item => [game.players.light, game.players.dark].includes(item.id)).map(publicUser) })
          return
        }
        if (request.method !== 'POST') fail(405, 'Метод недоступен')
        const body = await bodyJson(request)
        const change = await store.transact(state => {
          assertSession(state, auth)
          const game = gameById(state, id, user.id)
          if (game.phase === 'over') fail(409, 'Партия уже закончена')
          if (body.version !== game.version) fail(409, 'Позиция изменилась, обновите партию')
          const color = playerColor(game, user.id)
          const entries = []
          const add = (kind, text) => entries.push(event(game, kind, text))
          if (action === 'roll') {
            if (game.phase !== 'roll' || game.turn !== color) fail(409, 'Сейчас нельзя бросить кости')
            const first = randomInt(1, 7)
            const second = randomInt(1, 7)
            game.dice = [first, second]
            game.remaining = first === second ? [first, first, first, first] : [first, second]
            add('roll', `${color === 'light' ? 'Светлые' : 'Тёмные'}: бросок ${first} и ${second}${first === second ? ', дубль' : ''}.`)
            if (legalSequences(game.board, color, game.remaining).length) game.phase = 'move'
            else { game.phase = 'roll'; game.turn = opponent(color); game.remaining = []; add('system', 'Нет допустимых ходов, очередь передана сопернику.') }
          } else if (action === 'move') {
            if (game.phase !== 'move' || game.turn !== color) fail(409, 'Сейчас не ваш ход')
            const move = { from: body.from, to: body.to, die: body.die }
            const legal = firstMoves(legalSequences(game.board, color, game.remaining))
            if (!legal.some(item => sameMove(item, move))) fail(400, 'Недопустимый ход')
            const hit = move.to !== 'off' && game.board.points[move.to] === (color === 'light' ? -1 : 1)
            game.board = applyMove(game.board, color, move)
            game.remaining.splice(game.remaining.indexOf(move.die), 1)
            add('move', `${color === 'light' ? 'Светлые' : 'Тёмные'}: ${move.from === 'bar' ? 'бар' : move.from + 1} → ${move.to === 'off' ? 'вывод' : move.to + 1}, кость ${move.die}${hit ? ', сбита фишка' : ''}.`)
            if (game.board.off[color] === 15) {
              const kind = resultKind(game.board, color)
              const points = resultPoints(kind, game.cubeValue)
              game.phase = 'over'
              game.result = { winner: color, kind, points }
              add('result', `${color === 'light' ? 'Светлые' : 'Тёмные'} победили: ${kind === 'single' ? 'обычная победа' : kind === 'gammon' ? 'марс' : 'кокс'}, ${points} очк.`)
            } else if (legalSequences(game.board, color, game.remaining).length === 0) {
              game.phase = 'roll'
              game.turn = opponent(color)
              game.remaining = []
            }
          } else if (action === 'double') {
            if (game.phase !== 'roll' || game.turn !== color || (game.cubeOwner !== null && game.cubeOwner !== color)) fail(409, 'Сейчас нельзя удвоить')
            game.phase = 'offer'
            game.offerer = color
            add('cube', `${color === 'light' ? 'Светлые' : 'Тёмные'} предложили удвоение до ×${game.cubeValue * 2}.`)
          } else if (action === 'respond') {
            if (game.phase !== 'offer' || color === game.offerer || typeof body.accept !== 'boolean') fail(409, 'Нет предложения для ответа')
            if (body.accept) {
              game.cubeValue *= 2
              game.cubeOwner = color
              game.offerer = null
              game.phase = 'roll'
              add('cube', `Удвоение принято, куб ×${game.cubeValue}.`)
            } else {
              game.phase = 'over'
              game.result = { winner: game.offerer, kind: 'drop', points: game.cubeValue }
              game.offerer = null
              add('result', `Отказ от удвоения. Победителю ${game.cubeValue} очк.`)
            }
          } else if (action === 'resign') {
            game.phase = 'over'
            game.result = { winner: opponent(color), kind: 'resign', points: game.cubeValue }
            game.offerer = null
            add('result', `${color === 'light' ? 'Светлые' : 'Тёмные'} сдались. Сопернику ${game.cubeValue} очк.`)
          } else fail(404, 'Действие не найдено')
          return { game, entries }
        })
        const fileLogged = await writeEvents(change.game, change.entries)
        send(response, 200, { game: visibleGame(change.game, user.id), fileLogged })
        broadcast()
        return
      }
      fail(404, 'Адрес не найден')
    } catch (error) {
      if (response.headersSent) return
      send(response, error.status || 500, { error: error.status ? error.message : 'Ошибка сервера' })
      if (!error.status) console.error('API error:', error)
    }
  }
}
