import './style.css'
import './board-dice.css'
import './online.css'
import { pipCount } from './engine.ts'
import type { Board, Move, Origin, Player } from './engine.ts'
import { createDiceAnimator } from './board-dice.ts'
import type { BoardRoll } from './board-dice.ts'
import { bindBoardDragAndDrop, renderBoard } from './board-view.ts'
import { isSoundMuted, playSound, toggleSoundMuted } from './sound.ts'

interface User { id: string; name: string; role: 'admin' | 'player'; disabled: boolean }
interface Invitation { id: string; from?: string; to?: string; createdAt: string }
interface GameSummary { id: string; opponent: string; phase: string; updatedAt: string; result: { winner: Player; kind: string; points: number } | null }
interface Lobby { online: User[]; incoming: Invitation[]; outgoing: Invitation[]; games: GameSummary[] }
interface Game {
  id: string; players: Record<Player, string>; color: Player; board: Board; turn: Player;
  phase: 'move' | 'roll' | 'offer' | 'over'; dice: number[]; remaining: number[];
  lastRoll: { id: string; kind: 'opening' | 'turn'; player: Player; dice: number[]; at: string } | null;
  lastTurn: { player: Player; rollId: string | null; moves: Move[] } | null;
  cubeValue: number; cubeOwner: Player | null; offerer: Player | null;
  result: { winner: Player; kind: string; points: number } | null;
  events: { at: string; kind: string; text: string }[]; version: number; legalMoves: Move[]
}

class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const DEFAULT_TITLE = 'NARD | Онлайн'
const app = document.querySelector<HTMLDivElement>('#app')!
const diceAnimator = createDiceAnimator(app)
const BASE = import.meta.env.BASE_URL
let me: User | null = null
let lobby: Lobby | null = null
let adminUsers: User[] = []
let game: Game | null = null
let gameUsers: User[] = []
let screen: 'lobby' | 'admin' | 'game' = 'lobby'
let selected: Origin | null = null
let notice = ''
let revealedToken = ''
let live: EventSource | null = null
let refreshTimer: number | undefined
let liveStatus = 'Подключение'
let refreshPending = false
let refreshAgain = false
let seenRollKey: string | null = null
let flipped = false
let flipGameId: string | null = null

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const sideName = (side: Player) => side === 'light' ? 'Светлые' : 'Тёмные'
const time = (value: string) => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function isMyTurn(current: Game | null): boolean {
  if (!current || current.phase === 'over') return false
  return current.phase === 'offer' ? current.offerer !== current.color : current.turn === current.color
}

function updateDocumentTitle(): void {
  document.title = screen === 'game' && isMyTurn(game) ? `● Ваш ход — ${DEFAULT_TITLE}` : DEFAULT_TITLE
}

function setGame(next: Game, animateInitial = false): void {
  const prev = game
  const sameGame = prev?.id === next.id
  if (flipGameId !== next.id) {
    flipGameId = next.id
    flipped = next.color === 'dark'
  }
  game = next

  if (sameGame && prev && prev.version !== next.version) {
    const rolled = next.lastRoll?.id !== prev.lastRoll?.id
    if (next.phase === 'over' && prev.phase !== 'over') {
      playSound('win')
    } else if (rolled) {
      playSound('roll')
    } else if ((next.phase === 'offer' && prev.phase !== 'offer') || next.cubeValue !== prev.cubeValue) {
      playSound('cube')
    } else if (
      (next.lastTurn?.moves.length ?? 0) > (prev.lastTurn?.moves.length ?? 0)
      || (next.lastTurn && next.lastTurn.rollId !== prev.lastTurn?.rollId)
    ) {
      const hit = next.board.bar.light > prev.board.bar.light || next.board.bar.dark > prev.board.bar.dark
      playSound(hit ? 'hit' : 'move')
    } else if (!isMyTurn(prev) && isMyTurn(next)) {
      playSound('turn')
    }
  } else if (!sameGame && animateInitial && next.lastRoll && next.phase !== 'over') {
    playSound('roll')
  }

  const roll = next.lastRoll
  if (!roll) return
  const key = `${next.id}:${roll.id}`
  if (key === seenRollKey) return
  seenRollKey = key
  diceAnimator.stop()
  if (next.phase === 'over' || (!sameGame && !animateInitial)) return
  diceAnimator.start(() => render())
}

async function api<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const response = await fetch(`${BASE}${path.replace(/^\//, '')}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiRequestError(response.status, data.error || `HTTP ${response.status}`)
  return data as T
}

function playerName(side: Player): string {
  const id = game?.players[side]
  return gameUsers.find(user => user.id === id)?.name ?? sideName(side)
}

function canChoose(from: Origin): boolean {
  return !!game && !diceAnimator.isRolling() && game.phase === 'move' && game.turn === game.color && game.legalMoves.some(move => move.from === from)
}

function options(): Move[] {
  return selected === null ? [] : game?.legalMoves.filter(move => move.from === selected) ?? []
}

function moveButtons(): string {
  const moves = options()
  return moves.length ? `<div class="option-list">${moves.map((move, index) => `<button data-move="${index}">${move.to === 'off' ? 'Вывести' : `Пункт ${move.to + 1}`} · кость ${move.die}</button>`).join('')}</div>` : ''
}

function gameActions(): string {
  if (!game) return ''
  if (diceAnimator.isRolling()) return '<p class="action-hint">Кости катятся. Ход станет доступен после броска.</p>'
  if (game.phase === 'over') return '<button class="secondary-button" data-action="lobby">В лобби</button>'
  if (game.phase === 'offer') {
    return game.offerer !== game.color ? '<button class="primary-button" data-action="accept">Принять удвоение</button><button class="secondary-button" data-action="decline">Отказаться</button>' : '<p class="action-hint">Ожидаем решение соперника.</p>'
  }
  if (game.turn !== game.color) return '<p class="action-hint">Ожидаем ход соперника.</p>'
  if (game.phase === 'roll') return `<button class="primary-button" data-action="roll">Бросить кости <span>↗</span></button>${game.cubeOwner === null || game.cubeOwner === game.color ? '<button class="secondary-button" data-action="double">Предложить удвоение</button>' : ''}`
  return moveButtons() || '<p class="action-hint">Выберите свою фишку на поле.</p>'
}

function gameHtml(): string {
  const current = game!
  const status = current.phase === 'over' ? `Победа: ${playerName(current.result!.winner)}` : current.phase === 'offer' ? 'Решение по удвоению' : current.turn === current.color ? 'Ваш ход' : 'Ход соперника'
  const events = [...current.events].reverse().map(entry => `<li class="activity-item ${entry.kind}"><time>${time(entry.at)}</time><span>${escapeHtml(entry.text)}</span></li>`).join('')
  const bearOff = options().some(move => move.to === 'off')
  const lastMoves = current.lastTurn?.moves ?? []
  const offLastTo = lastMoves.some(move => move.to === 'off')
  const roll: BoardRoll | null = current.lastRoll && current.lastRoll.dice.length >= 2
    ? { kind: current.lastRoll.kind, player: current.lastRoll.player, dice: [current.lastRoll.dice[0], current.lastRoll.dice[1]] }
    : current.dice.length >= 2
      ? { kind: 'turn', player: current.turn, dice: [current.dice[0], current.dice[1]] }
      : null
  const board = renderBoard({
    board: current.board,
    selected,
    legalMoves: current.legalMoves,
    interactive: current.phase === 'move' && current.turn === current.color,
    flipped,
    lastMoves,
    roll,
    remaining: current.remaining,
    inMovePhase: current.phase === 'move',
    diceAnimator,
    labelForSide: side => playerName(side),
  })
  return `<div class="online-game-layout"><section class="game-area"><div class="board-head"><div><span class="eyebrow">ОНЛАЙН-ПАРТИЯ</span><h1>${escapeHtml(playerName('light'))} / ${escapeHtml(playerName('dark'))}</h1></div><div class="board-head-meta">ВАШ ЦВЕТ: ${sideName(current.color).toUpperCase()}</div></div>${board}<div class="board-footer"><button class="off-target ${bearOff ? 'possible' : ''} ${offLastTo ? 'last-to' : ''}" data-off data-destination="off"><span class="target-icon">◎</span><span>ВЫВЕСТИ ФИШКУ</span></button><div class="board-footer-meta"><button class="board-tool-button" data-action="flip" title="Перевернуть доску" aria-label="Перевернуть доску">⇅ Перевернуть</button><span>Ходы подтверждает сервер</span></div></div></section>
    <aside class="sidebar online-sidebar"><div class="sidebar-top"><span class="eyebrow">${status.toUpperCase()}</span><button class="icon-button" data-action="lobby" aria-label="В лобби">↖</button></div><div class="online-player-row ${current.phase !== 'over' && current.turn === 'light' ? 'active' : ''}"><span class="player-symbol light"></span><span class="online-player-name">${escapeHtml(playerName('light'))}</span><span class="online-player-pips">${pipCount(current.board, 'light')} пип.</span></div><div class="online-player-row ${current.phase !== 'over' && current.turn === 'dark' ? 'active' : ''}"><span class="player-symbol dark"></span><span class="online-player-name">${escapeHtml(playerName('dark'))}</span><span class="online-player-pips">${pipCount(current.board, 'dark')} пип.</span></div><div class="turn-panel"><strong>${status}</strong><p>Куб ×${current.cubeValue}</p>${current.result ? `<p>Результат: ${current.result.points} очк.</p>` : ''}</div><div class="actions">${gameActions()}</div>${current.phase !== 'over' ? '<button class="online-resign" data-action="resign">Сдаться</button>' : ''}<div class="activity-panel"><div class="activity-head"><span class="eyebrow">ХОД ПАРТИИ</span><span>ЗАПИСИ · ${current.events.length}</span></div><ol class="activity-list">${events}</ol></div></aside></div>`
}

function lobbyHtml(): string {
  const current = lobby!
  const people = current.online.length ? current.online.map(user => `<div class="online-row"><span><span class="presence-dot"></span>${escapeHtml(user.name)}</span><button class="secondary-button" data-invite="${user.id}">Пригласить</button></div>`).join('') : '<p class="online-empty">Сейчас другие игроки не в сети.</p>'
  const incoming = current.incoming.length ? current.incoming.map(invite => `<div class="online-row"><span>От ${escapeHtml(invite.from || '')}</span><span class="inline-actions"><button class="small-accept" data-accept="${invite.id}">Принять</button><button class="small-decline" data-decline="${invite.id}">Отклонить</button></span></div>`).join('') : '<p class="online-empty">Новых приглашений нет.</p>'
  const outgoing = current.outgoing.map(invite => `<div class="online-row"><span>Для ${escapeHtml(invite.to || '')}</span><small>Ожидаем ответ</small></div>`).join('')
  const games = current.games.length ? current.games.map(item => `<div class="online-row"><span>${escapeHtml(item.opponent)} <small>· ${item.phase === 'over' ? 'завершена' : 'идёт игра'}</small></span><button class="secondary-button" data-game="${item.id}">Открыть</button></div>`).join('') : '<p class="online-empty">Партий пока нет.</p>'
  return `<div class="online-sections"><section class="online-card"><span class="eyebrow">ИГРОКИ В СЕТИ</span><h2>Пригласить в партию</h2>${people}</section><section class="online-card"><span class="eyebrow">ПРИГЛАШЕНИЯ</span><h2>Ваши приглашения</h2>${incoming}${outgoing}</section><section class="online-card wide"><span class="eyebrow">ПАРТИИ</span><h2>История игр</h2>${games}</section></div>`
}

function adminHtml(): string {
  const users = adminUsers.map(user => `<div class="online-row"><span>${escapeHtml(user.name)} <small>· ${user.role === 'admin' ? 'администратор' : user.disabled ? 'отключён' : 'активен'}</small></span>${user.role === 'player' ? `<span class="inline-actions"><button class="small-accept" data-rotate="${user.id}">Новый токен</button><button class="small-decline" data-toggle="${user.id}">${user.disabled ? 'Включить' : 'Отключить'}</button></span>` : ''}</div>`).join('')
  return `<div class="online-sections"><section class="online-card"><span class="eyebrow">АДМИНИСТРАТОР</span><h2>Создать аккаунт</h2><form data-form="create-user" class="online-form"><label>Имя игрока<input name="name" minlength="3" maxlength="32" required autocomplete="off" /></label><button class="primary-button">Создать и выдать токен</button></form>${revealedToken ? `<div class="token-result"><strong>Токен показан один раз</strong><code>${escapeHtml(revealedToken)}</code><button class="secondary-button" data-action="copy-token">Скопировать</button></div>` : ''}</section><section class="online-card"><span class="eyebrow">АККАУНТЫ</span><h2>Пользователи</h2>${users}</section></div>`
}

function render(): void {
  updateDocumentTitle()
  if (!me) {
    app.innerHTML = `<div class="online-shell"><header class="site-header"><div class="brand"><img class="brand-mark" src="${BASE}die-logo.svg" alt="" /><div><strong>NARD</strong><small>ОНЛАЙН-ПАРТИИ</small></div></div><a class="text-button" href="${BASE}">Локальная игра ↗</a></header><main class="login-wrap"><section class="online-card login-card"><span class="eyebrow">ВХОД ПО ПРИГЛАШЕНИЮ</span><h1>Сыграем партию?</h1><p>Введите личный токен, который выдал администратор. Регистрация открыта только ему.</p><form data-form="login" class="online-form"><label>Личный токен<input type="password" name="token" autocomplete="off" required /></label><button class="primary-button">Войти <span>↗</span></button></form>${notice ? `<p class="online-notice" role="alert">${escapeHtml(notice)}</p>` : ''}</section></main></div>`
    return
  }
  const muted = isSoundMuted()
  app.innerHTML = `<div class="shell"><header class="site-header"><div class="brand"><img class="brand-mark" src="${BASE}die-logo.svg" alt="" /><div><strong>NARD</strong><small>ОНЛАЙН-ПАРТИИ</small></div></div><div class="header-right"><span class="mode-pill"><span></span>${escapeHtml(me.name)} · ${liveStatus}</span><button class="text-button" data-action="mute" aria-pressed="${muted}" title="${muted ? 'Включить звук' : 'Выключить звук'}">${muted ? 'Звук выкл' : 'Звук вкл'}</button><a class="text-button" href="${BASE}">Локальная игра ↗</a><button class="text-button" data-action="logout">Выйти</button></div></header><main class="online-main"><nav class="online-nav"><button data-action="lobby" class="${screen !== 'admin' ? 'active' : ''}">Лобби</button>${me.role === 'admin' ? `<button data-action="admin" class="${screen === 'admin' ? 'active' : ''}">Админ-панель</button>` : ''}</nav>${notice ? `<p class="online-notice" role="status">${escapeHtml(notice)}</p>` : ''}${screen === 'game' && game ? gameHtml() : screen === 'admin' ? adminHtml() : lobby ? lobbyHtml() : '<p class="online-empty">Загружаем лобби...</p>'}</main></div>`
}

async function refresh(): Promise<void> {
  if (!me) return
  if (refreshPending) { refreshAgain = true; return }
  refreshPending = true
  try {
    const hadLobby = lobby !== null
    const hadActiveGame = lobby?.games.some(item => item.phase !== 'over') ?? false
    const nextLobby = await api<Lobby>('/api/lobby')
    lobby = nextLobby
    if (screen === 'lobby') {
      const active = nextLobby.games.find(item => item.phase !== 'over')
      if (active) {
        const result = await api<{ game: Game; users: User[] }>(`/api/games/${active.id}`)
        screen = 'game'; setGame(result.game, hadLobby && !hadActiveGame); gameUsers = result.users
      }
    } else if (screen === 'game' && game) {
      const result = await api<{ game: Game; users: User[] }>(`/api/games/${game.id}`)
      setGame(result.game)
      gameUsers = result.users
    }
    if (screen === 'admin') adminUsers = (await api<{ users: User[] }>('/api/admin/users')).users
    render()
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      stopLive(); diceAnimator.stop(); me = null; game = null; screen = 'lobby'; notice = 'Сессия завершена. Войдите снова.'; render(); return
    }
    notice = error instanceof Error ? error.message : 'Не удалось обновить данные'
    render()
  } finally {
    refreshPending = false
    if (refreshAgain) { refreshAgain = false; void refresh() }
  }
}

function stopLive(): void {
  live?.close()
  live = null
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
  refreshTimer = undefined
}

function connectLive(): void {
  stopLive()
  live = new EventSource(`${BASE}api/live`)
  refreshTimer = window.setInterval(() => { void refresh() }, 30_000)
  live.onopen = () => { liveStatus = 'в сети'; render() }
  live.onerror = () => {
    liveStatus = 'переподключение'; render()
    void api('/api/auth/me').catch(error => {
      if (error instanceof ApiRequestError && error.status === 401) {
        stopLive(); diceAnimator.stop(); me = null; game = null; screen = 'lobby'; notice = 'Сессия завершена. Войдите снова.'; render()
      }
    })
  }
  live.addEventListener('refresh', () => { void refresh() })
}

async function openGame(id: string, animateInitial = false): Promise<void> {
  const result = await api<{ game: Game; users: User[] }>(`/api/games/${id}`)
  setGame(result.game, animateInitial)
  gameUsers = result.users
  selected = null
  screen = 'game'
  notice = ''
  render()
}

async function gameAction(action: string, payload: object = {}): Promise<void> {
  if (!game) return
  try {
    const result = await api<{ game: Game; fileLogged: boolean }>(`/api/games/${game.id}/${action}`, 'POST', { ...payload, version: game.version })
    setGame(result.game)
    selected = null
    notice = result.fileLogged ? '' : 'Ход сохранён, но файловый журнал недоступен.'
    render()
  } catch (error) { notice = error instanceof Error ? error.message : 'Ошибка хода'; await refresh() }
}

app.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement
  event.preventDefault()
  if (form.dataset.form === 'login') {
    const token = (new FormData(form).get('token') || '').toString()
    form.reset()
    void api<{ user: User }>('/api/auth/login', 'POST', { token }).then(async result => {
      diceAnimator.stop(); seenRollKey = null; flipGameId = null; me = result.user; screen = 'lobby'; game = null; revealedToken = ''; notice = ''; connectLive(); await refresh()
    }).catch(error => { notice = error.message; render() })
  }
  if (form.dataset.form === 'create-user') {
    const name = (new FormData(form).get('name') || '').toString()
    void api<{ user: User; token: string }>('/api/admin/users', 'POST', { name }).then(async result => {
      revealedToken = result.token; notice = `Аккаунт «${result.user.name}» создан.`; await refresh()
    }).catch(error => { notice = error.message; render() })
  }
})

app.addEventListener('click', event => {
  const target = event.target as HTMLElement
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
  if (action) {
    if (action === 'logout') void api('/api/auth/logout', 'POST').catch(() => {}).finally(() => { stopLive(); diceAnimator.stop(); me = null; game = null; flipGameId = null; screen = 'lobby'; revealedToken = ''; notice = ''; render() })
    if (action === 'lobby') { diceAnimator.stop(); screen = 'lobby'; game = null; selected = null; notice = ''; void refresh() }
    if (action === 'admin') { diceAnimator.stop(); screen = 'admin'; revealedToken = ''; notice = ''; void refresh() }
    if (action === 'flip') { flipped = !flipped; render() }
    if (action === 'mute') { toggleSoundMuted(); render() }
    if (action === 'copy-token' && revealedToken) {
      if (!navigator.clipboard) { notice = 'Скопируйте токен вручную.'; render() }
      else void navigator.clipboard.writeText(revealedToken).then(() => { notice = 'Токен скопирован.'; render() }).catch(() => { notice = 'Скопируйте токен вручную.'; render() })
    }
    if (['roll', 'double', 'accept', 'decline', 'resign'].includes(action)) {
      if (action === 'resign' && !window.confirm('Сдаться и завершить партию?')) return
      const route = action === 'accept' || action === 'decline' ? 'respond' : action
      void gameAction(route, action === 'accept' ? { accept: true } : action === 'decline' ? { accept: false } : {})
    }
    return
  }
  const invite = target.closest<HTMLElement>('[data-invite]')?.dataset.invite
  if (invite) { void api('/api/invites', 'POST', { to: invite }).then(async () => { notice = 'Приглашение отправлено.'; await refresh() }).catch(error => { notice = error.message; render() }); return }
  const accept = target.closest<HTMLElement>('[data-accept]')?.dataset.accept
  if (accept) { void api<{ gameId: string; fileLogged: boolean }>(`/api/invites/${accept}/accept`, 'POST', {}).then(async result => { await openGame(result.gameId, true); if (!result.fileLogged) { notice = 'Партия создана, но файловый журнал недоступен.'; render() } }).catch(error => { notice = error.message; render() }); return }
  const decline = target.closest<HTMLElement>('[data-decline]')?.dataset.decline
  if (decline) { void api(`/api/invites/${decline}/decline`, 'POST', {}).then(() => refresh()).catch(error => { notice = error.message; render() }); return }
  const gameId = target.closest<HTMLElement>('[data-game]')?.dataset.game
  if (gameId) { void openGame(gameId).catch(error => { notice = error.message; render() }); return }
  const rotate = target.closest<HTMLElement>('[data-rotate]')?.dataset.rotate
  if (rotate) { void api<{ token: string }> (`/api/admin/users/${rotate}/rotate`, 'POST', {}).then(async result => { revealedToken = result.token; notice = 'Новый токен выдан, старые сессии завершены.'; await refresh() }).catch(error => { notice = error.message; render() }); return }
  const toggle = target.closest<HTMLElement>('[data-toggle]')?.dataset.toggle
  if (toggle) { void api(`/api/admin/users/${toggle}/toggle`, 'POST', {}).then(async () => { notice = 'Статус аккаунта изменён.'; await refresh() }).catch(error => { notice = error.message; render() }); return }
  if (!game || screen !== 'game' || (!canChoose('bar') && !game.legalMoves.length)) return
  const moveIndex = target.closest<HTMLElement>('[data-move]')?.dataset.move
  if (moveIndex !== undefined) { const move = options()[Number(moveIndex)]; if (move) void gameAction('move', move); return }
  if (target.closest('[data-bar]') && canChoose('bar')) { selected = 'bar'; render(); return }
  const off = target.closest('[data-off]')
  if (off) { const moves = options().filter(move => move.to === 'off'); if (moves.length === 1) void gameAction('move', moves[0]); else if (moves.length > 1) { notice = 'Выберите нужную кость в списке доступных ходов.'; render() } return }
  const point = target.closest<HTMLElement>('[data-point]')?.dataset.point
  if (point !== undefined) {
    const index = Number(point)
    const moves = options().filter(move => move.to === index)
    if (moves.length === 1) { void gameAction('move', moves[0]); return }
    if (moves.length > 1) { notice = 'Выберите нужную кость в списке доступных ходов.'; render(); return }
    if (canChoose(index)) { selected = index; render() }
  }
})

bindBoardDragAndDrop(app, {
  canDrag: from => screen === 'game' && canChoose(from),
  legalMoves: () => game?.legalMoves ?? [],
  onMove: move => { void gameAction('move', move) },
  onAmbiguous: from => {
    selected = from
    notice = 'Выберите нужную кость в списке доступных ходов.'
    render()
  },
})

void api<{ user: User }>('/api/auth/me').then(async result => {
  me = result.user; connectLive(); await refresh()
}).catch(() => { me = null; render() })
