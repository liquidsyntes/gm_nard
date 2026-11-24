import './style.css'
import './board-dice.css'
import { applyMove, firstMoves, initialBoard, legalSequences, opponent, pipCount, resultKind, resultPoints, sameMove } from './engine.ts'
import { chooseBotPlay, shouldAcceptDouble, shouldOfferDouble } from './bot.ts'
import { createDiceAnimator } from './board-dice.ts'
import type { BoardRoll } from './board-dice.ts'
import { bindBoardDragAndDrop, renderBoard } from './board-view.ts'
import { isSoundMuted, playSound, toggleSoundMuted } from './sound.ts'
import type { Board, Destination, Move, Origin, Player } from './engine.ts'

type Phase = 'opening' | 'roll' | 'move' | 'offer' | 'over'
type Mode = 'local' | 'bot' | 'demo'
type LogKind = 'system' | 'roll' | 'move' | 'cube' | 'result'
interface LogEntry { id: number; time: string; text: string; kind: LogKind }
interface Snapshot { board: Board; sequences: Move[][]; remaining: number[]; logId: number; move: Move; lastTurnMoves: Move[] }

let mode: Mode = 'local'
let paused = false
let flipped = false
let board = initialBoard()
let phase: Phase = 'opening'
let player: Player = 'light'
let lastRoll: BoardRoll | null = null
let lastTurnMoves: Move[] = []
let remaining: number[] = []
let sequences: Move[][] = []
let selected: Origin | null = null
let history: Snapshot[] = []
let score: Record<Player, number> = { light: 0, dark: 0 }
let cubeValue = 1
let cubeOwner: Player | null = null
let offerer: Player | null = null
let notice = 'Начните партию: каждый игрок бросит по одной кости.'
let rulesOpen = false
let winner: Player | null = null
let botPlan: Move[] = []
let botBusy = false
let botTimer: number | undefined
let botRequestId = 0
let gameVersion = 0
let botWorker: Worker | null = null
let gameNumber = 0
let nextLogId = 0
let logEntries: LogEntry[] = []
let fileLogFailed = false
let pendingFileWrites = 0
let fileWriteQueue: Promise<void> = Promise.resolve()

const app = document.querySelector<HTMLDivElement>('#app')!
const diceAnimator = createDiceAnimator(app)
const BASE = import.meta.env.BASE_URL
const newSessionId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
let sessionId = newSessionId()
const name = (side: Player) => side === 'light' ? 'Светлые' : 'Тёмные'
const dieLabel = (value: number) => ['','⚀','⚁','⚂','⚃','⚄','⚅'][value]
const pointWord = (value: number) => value % 100 >= 11 && value % 100 <= 14 ? 'очков' : value % 10 === 1 ? 'очко' : value % 10 >= 2 && value % 10 <= 4 ? 'очка' : 'очков'
const isBot = (side: Player) => mode === 'demo' || (mode === 'bot' && side === 'dark')
const isAutomated = () => mode === 'demo' && (phase === 'opening' || phase === 'over')
  || phase === 'offer' && offerer !== null && isBot(opponent(offerer))
  || (phase === 'roll' || phase === 'move') && isBot(player)
const actor = (side: Player) => mode === 'bot' && side === 'light' ? 'Вы' : isBot(side) ? `Бот (${name(side).toLowerCase()})` : name(side)
const fileStatus = () => fileLogFailed ? 'error' : pendingFileWrites > 0 ? 'saving' : 'saved'
const fileStatusText = () => fileLogFailed ? 'ФАЙЛ НЕДОСТУПЕН' : pendingFileWrites > 0 ? 'ЗАПИСЬ В ФАЙЛ...' : 'ФАЙЛ СОХРАНЁН'

function updateFileStatus(): void {
  const element = app.querySelector<HTMLElement>('[data-file-log-status]')
  if (element) { element.dataset.state = fileStatus(); element.textContent = fileStatusText() }
}

function record(text: string, kind: LogKind = 'system'): void {
  logEntries.push({ id: ++nextLogId, time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), text, kind })
  if (logEntries.length > 150) logEntries.shift()
  const payload = JSON.stringify({ session: sessionId, game: gameNumber, kind, text })
  pendingFileWrites++
  updateFileStatus()
  fileWriteQueue = fileWriteQueue.then(async () => {
    const response = await fetch(`${BASE}api/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
    if (!response.ok) throw new Error(`File log HTTP ${response.status}`)
  }).then(() => {
    pendingFileWrites--
    fileLogFailed = false
    updateFileStatus()
  }, () => {
    pendingFileWrites--
    fileLogFailed = true
    updateFileStatus()
  })
}

function moveText(move: Move): string {
  return `${move.from === 'bar' ? 'бар' : move.from + 1} → ${move.to === 'off' ? 'вывод' : move.to + 1}, кость ${move.die}`
}

function randomDie(): number {
  const limit = Math.floor(0x100000000 / 6) * 6
  const values = new Uint32Array(1)
  do crypto.getRandomValues(values); while (values[0] >= limit)
  return values[0] % 6 + 1
}

function formatDestination(to: Destination): string {
  return to === 'off' ? 'Вывести' : `Пункт ${to + 1}`
}

function canSelect(from: Origin): boolean {
  return phase === 'move' && !diceAnimator.isRolling() && !isBot(player) && firstMoves(sequences).some(move => move.from === from)
}

function moveOptions(): Move[] {
  return selected === null ? [] : firstMoves(sequences).filter(move => move.from === selected)
}

function startDiceAnimation(): void {
  diceAnimator.start(() => render())
}

function playerCard(side: Player): string {
  return `<div class="player-card ${player === side && phase !== 'over' ? 'active' : ''}">
    <span class="player-symbol ${side}"></span><div><strong>${name(side)} ${isBot(side) ? '<em>БОТ</em>' : ''}</strong><small>${side === 'light' ? 'Кремовые' : 'Графитовые'} · <span class="pip-count">${pipCount(board, side)} пип.</span></small></div>
    <span class="score">${score[side]}<small>очк.</small></span>
  </div>`
}

function actionHtml(): string {
  if (diceAnimator.isRolling() && mode !== 'demo') return '<p class="action-hint">Кости катятся. Ход станет доступен после броска.</p>'
  if (mode === 'demo') return `<p class="action-hint">${paused ? 'Автоматическая партия остановлена.' : botBusy ? 'Бот рассчитывает ход...' : phase === 'over' ? 'Следующая партия начнётся автоматически.' : 'Боты играют автоматически.'}</p><button class="${paused ? 'primary-button' : 'secondary-button'}" data-action="pause">${paused ? 'Продолжить' : 'Пауза'}</button>`
  if (isAutomated()) return `<p class="action-hint">${botBusy ? 'Бот рассчитывает ход...' : 'Бот играет, подождите...'}</p>`
  if (phase === 'opening') return '<button class="primary-button" data-action="open">Определить первый ход <span>↗</span></button>'
  if (phase === 'offer') return `<div class="offer-actions"><button class="primary-button" data-action="accept">Принять ×${cubeValue * 2}</button><button class="secondary-button" data-action="pass">Отказаться</button></div>`
  if (phase === 'roll') return `<button class="primary-button" data-action="roll">Бросить кости <span>↗</span></button>${cubeOwner === null || cubeOwner === player ? `<button class="secondary-button" data-action="double">Предложить удвоение</button>` : ''}`
  if (phase === 'over') return '<button class="primary-button" data-action="new">Новая партия <span>↗</span></button>'
  const completed = firstMoves(sequences).length === 0
  return `${completed ? '<button class="primary-button" data-action="finish">Завершить ход <span>↗</span></button>' : '<p class="action-hint">Выберите фишку и пункт назначения</p>'}${history.length ? '<button class="secondary-button" data-action="undo">Отменить ход</button>' : ''}`
}

function optionsHtml(): string {
  if (isBot(player)) return ''
  const options = moveOptions()
  if (phase !== 'move' || !options.length) return ''
  return `<div class="move-options"><span class="eyebrow">Доступные ходы</span><div class="option-list">${options.map((move, index) => `<button data-move="${index}"><span>${formatDestination(move.to)}</span><b>${dieLabel(move.die)} <small>${move.die}</small></b></button>`).join('')}</div></div>`
}

function logHtml(): string {
  return `<section class="activity-panel" aria-label="Журнал игры"><div class="activity-head"><span class="eyebrow">ЖУРНАЛ ИГРЫ</span><span>ЗАПИСИ · ${logEntries.length}</span></div><div class="file-log-status" data-file-log-status data-state="${fileStatus()}">${fileStatusText()}</div><ol class="activity-list" aria-live="off">${[...logEntries].reverse().map(entry => `<li class="activity-item ${entry.kind}"><time>${entry.time}</time><span>${entry.text}</span></li>`).join('')}</ol></section>`
}

function render(): void {
  const offOption = moveOptions().some(move => move.to === 'off')
  const offLastTo = lastTurnMoves.some(move => move.to === 'off')
  const phaseLabel = phase === 'opening' ? 'Подготовка' : phase === 'offer' ? 'Решение за соперником' : phase === 'over' ? 'Партия окончена' : phase === 'roll' ? 'Ваш бросок' : firstMoves(sequences).length ? 'Ваш ход' : 'Ход завершён'
  const muted = isSoundMuted()
  const boardHtml = renderBoard({
    board,
    selected,
    legalMoves: firstMoves(sequences),
    interactive: phase === 'move' && !isBot(player),
    flipped,
    lastMoves: lastTurnMoves,
    roll: lastRoll,
    remaining,
    inMovePhase: phase === 'move',
    diceAnimator,
  })
  app.innerHTML = `<div class="shell">
    <header class="site-header"><div class="brand"><img class="brand-mark" src="${BASE}die-logo.svg" alt="" /><div><strong>NARD</strong><small>КОРОТКИЕ НАРДЫ</small></div></div><div class="header-right"><span class="mode-pill"><span></span> ${mode === 'local' ? 'ИГРА ВДВОЁМ' : mode === 'bot' ? 'ИГРА С БОТОМ' : 'БОТ VS БОТ'}</span><button class="text-button" data-action="mute" aria-pressed="${muted}" title="${muted ? 'Включить звук' : 'Выключить звук'}">${muted ? 'Звук выкл' : 'Звук вкл'}</button><a class="text-button" href="${BASE}online.html">Онлайн ↗</a><button class="text-button" data-action="rules">Правила <span>↗</span></button></div></header>
    <main class="layout">
      <section class="game-area" aria-label="Игровое поле">
        <div class="board-head"><div><span class="eyebrow">КЛАССИЧЕСКАЯ ПАРТИЯ</span><h1>Игра начинается здесь.</h1></div><div class="board-head-meta"><span>24 ПУНКТА</span><i></i><span>15 ФИШЕК</span></div></div>
        ${boardHtml}
        <div class="board-footer"><button class="off-target ${offOption ? 'possible' : ''} ${offLastTo ? 'last-to' : ''}" data-destination="off"><span class="target-icon">◎</span><span>ВЫВЕСТИ ФИШКУ</span></button><div class="board-footer-meta"><button class="board-tool-button" data-action="flip" title="Перевернуть доску" aria-label="Перевернуть доску">⇅ Перевернуть</button><span>${flipped ? 'Тёмные движутся от 1 к 24' : 'Светлые движутся от 24 к 1'} <span class="footer-arrow">↘</span></span></div></div>
      </section>
      <aside class="sidebar"><div class="sidebar-top"><span class="eyebrow">КЛАССИЧЕСКАЯ ИГРА</span><button class="icon-button" data-action="new" title="Новая партия" aria-label="Новая партия">↻</button></div>
        <label class="mode-control"><span class="eyebrow">РЕЖИМ ИГРЫ</span><select aria-label="Режим игры" data-mode><option value="local" ${mode === 'local' ? 'selected' : ''}>Два игрока</option><option value="bot" ${mode === 'bot' ? 'selected' : ''}>Против бота</option><option value="demo" ${mode === 'demo' ? 'selected' : ''}>Бот против бота</option></select></label>
        <div class="players">${playerCard('light')}<div class="versus">VS <span>•</span> ${phase === 'over' ? 'ФИНИШ' : 'ХОД'}</div>${playerCard('dark')}</div>
        <div class="turn-panel" aria-live="polite"><span class="eyebrow">${phaseLabel.toUpperCase()}</span><strong>${phase === 'offer' ? name(opponent(offerer!)) : phase === 'over' ? `${name(winner!)} победили` : phase === 'opening' ? 'Кто начнёт?' : name(player)}</strong><p>${notice}</p></div>
        <div class="dice-panel"><div class="dice-title"><span class="eyebrow">КУБ УДВОЕНИЯ</span><span class="cube"><b>×${cubeValue}</b>${cubeOwner ? ` · ${name(cubeOwner)}` : ''}</span></div></div>
        ${optionsHtml()}<div class="actions">${actionHtml()}</div>${logHtml()}
        <div class="sidebar-bottom"><span class="tiny-diamond">◇</span> Первый, кто выведет все 15 фишек, побеждает.</div>
      </aside>
    </main>
    <footer class="site-footer"><span>© NARD / ВЕБ-ИГРА</span><span>СДЕЛАНО ДЛЯ ИГРЫ ВМЕСТЕ</span></footer>
    ${rulesOpen ? `<div class="modal-backdrop" data-action="close-rules"><section class="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title"><button class="modal-close" data-action="close-rules" aria-label="Закрыть правила">×</button><span class="eyebrow">КОРОТКИЕ НАРДЫ</span><h2 id="rules-title">Как играть</h2><p>Каждый игрок ведёт 15 фишек навстречу сопернику, собирает их в своём доме и выводит с доски. Светлые идут от пункта 24 к 1, тёмные в обратную сторону.</p><ol><li>Числа на костях играются как отдельные ходы. Дубль даёт четыре одинаковых хода. Нужно использовать максимум доступных костей; если доступна только одна из двух, играется старшая.</li><li>Пункт с двумя чужими фишками закрыт. Одиночную чужую фишку можно сбить на бар. Пока на баре есть свои фишки, сначала введите их в игру.</li><li>Выводить фишки можно, когда все свои фишки находятся в доме. Если нужный пункт пуст, сначала двигайте фишку с более дальнего пункта. Если таких нет, выводите с самого дальнего занятого.</li><li>Победа стоит одно очко, марс два, кокс три. Куб удвоения меняет стоимость партии и предлагается до броска.</li></ol><button class="primary-button" data-action="close-rules">Понятно</button></section></div>` : ''}
  </div>`
  if (rulesOpen) document.querySelector<HTMLButtonElement>('.modal-close')?.focus()
  queueBotStep()
}

function startGame(): void {
  diceAnimator.stop()
  lastRoll = null
  lastTurnMoves = []
  gameVersion++
  gameNumber++
  botPlan = []
  botBusy = false
  board = initialBoard()
  phase = 'opening'
  player = 'light'
  remaining = []
  sequences = []
  selected = null
  history = []
  cubeValue = 1
  cubeOwner = null
  offerer = null
  winner = null
  notice = 'Начните партию: каждый игрок бросит по одной кости.'
  record(`Партия ${gameNumber} началась. Режим: ${mode === 'local' ? 'два игрока' : mode === 'bot' ? 'против бота' : 'бот против бота'}.`)
  render()
}

function openingRoll(): void {
  let light = randomDie()
  let dark = randomDie()
  while (light === dark) { light = randomDie(); dark = randomDie() }
  player = light > dark ? 'light' : 'dark'
  lastRoll = { kind: 'opening', player, dice: [light, dark] }
  lastTurnMoves = []
  remaining = [light, dark]
  sequences = legalSequences(board, player, remaining)
  botPlan = []
  phase = 'move'
  notice = `Светлые выбросили ${light}, тёмные ${dark}. ${name(player)} начинают и играют оба числа.`
  record(`Первый бросок: светлые ${light}, тёмные ${dark}. Начинают ${name(player).toLowerCase()}.`, 'roll')
  playSound('roll')
  startDiceAnimation()
  render()
}

function roll(): void {
  const first = randomDie()
  const second = randomDie()
  lastRoll = { kind: 'turn', player, dice: [first, second] }
  remaining = first === second ? [first, first, first, first] : [first, second]
  sequences = legalSequences(board, player, remaining)
  botPlan = []
  history = []
  selected = board.bar[player] > 0 ? 'bar' : null
  phase = 'move'
  notice = sequences.length ? first === second ? `Дубль ${first}:${second}. Можно сделать четыре хода.` : `Выпало ${first} и ${second}. Выберите фишку.` : 'Допустимых ходов нет. Передайте ход сопернику.'
  record(`${actor(player)}: бросок ${first} и ${second}${first === second ? ', дубль' : ''}.`, 'roll')
  playSound('roll')
  startDiceAnimation()
  render()
}

function play(move: Move): void {
  if (phase !== 'move' || diceAnimator.isRolling() || !firstMoves(sequences).some(candidate => sameMove(candidate, move))) return
  history.push({ board, sequences, remaining: [...remaining], logId: nextLogId, move, lastTurnMoves: [...lastTurnMoves] })
  const hit = move.to !== 'off' && board.points[move.to] === (player === 'light' ? -1 : 1)
  board = applyMove(board, player, move)
  sequences = sequences.filter(sequence => sameMove(sequence[0], move)).map(sequence => sequence.slice(1))
  remaining.splice(remaining.indexOf(move.die), 1)
  lastTurnMoves = history.length === 1 ? [move] : [...lastTurnMoves, move]
  selected = board.bar[player] > 0 ? 'bar' : null
  notice = board.off[player] === 15 ? 'Все фишки выведены. Завершите ход, чтобы зафиксировать победу.' : firstMoves(sequences).length ? 'Продолжайте ход.' : 'Все доступные ходы сыграны. Завершите ход.'
  record(`${actor(player)}: ${moveText(move)}${hit ? ', сбита фишка соперника' : ''}.`, 'move')
  playSound(hit ? 'hit' : 'move')
  render()
}

function finishTurn(): void {
  if (phase !== 'move' || firstMoves(sequences).length) return
  if (board.off[player] === 15) {
    const kind = resultKind(board, player)
    const points = resultPoints(kind, cubeValue)
    score[player] += points
    winner = player
    phase = 'over'
    notice = `${kind === 'single' ? 'Обычная победа' : kind === 'gammon' ? 'Марс' : 'Кокс'}: +${points} ${pointWord(points)} к счёту.`
    record(`${actor(player)}: ${kind === 'single' ? 'победа' : kind === 'gammon' ? 'марс' : 'кокс'}, +${points} ${pointWord(points)}.`, 'result')
    playSound('win')
  } else {
    if (history.length === 0) {
      lastTurnMoves = []
      record(`${actor(player)}: пропуск хода, нет допустимых перемещений.`)
    }
    player = opponent(player)
    phase = 'roll'
    notice = 'Бросьте кости или предложите удвоение до броска.'
    remaining = []
    history = []
    sequences = []
    botPlan = []
  }
  selected = null
  render()
}

function activateAction(action: string): void {
  switch (action) {
    case 'open': if (phase === 'opening') openingRoll(); break
    case 'roll': if (phase === 'roll') roll(); break
    case 'finish': finishTurn(); break
    case 'new': startGame(); break
    case 'flip': flipped = !flipped; render(); break
    case 'mute': toggleSoundMuted(); render(); break
    case 'pause': if (mode === 'demo') { paused = !paused; record(paused ? 'Автоматическая игра остановлена.' : 'Автоматическая игра продолжена.'); render() } break
    case 'undo': {
      if (phase !== 'move') break
      const snapshot = history.pop()
      if (!snapshot) break
      board = snapshot.board
      sequences = snapshot.sequences
      remaining = snapshot.remaining
      lastTurnMoves = snapshot.lastTurnMoves
      logEntries = logEntries.filter(entry => entry.id <= snapshot.logId)
      record(`${actor(player)}: отмена хода ${moveText(snapshot.move)}.`)
      selected = board.bar[player] > 0 ? 'bar' : null
      notice = 'Последний ход отменён. Выберите фишку.'
      render()
      break
    }
    case 'double':
      if (phase !== 'roll' || (cubeOwner !== null && cubeOwner !== player)) break
      offerer = player
      phase = 'offer'
      notice = `${name(player)} предлагают удвоить стоимость партии. ${name(opponent(player))} должны принять или отказаться.`
      record(`${actor(player)}: предложение удвоить куб до ×${cubeValue * 2}.`, 'cube')
      playSound('cube')
      render()
      break
    case 'accept':
      if (phase !== 'offer' || !offerer) break
      cubeOwner = opponent(offerer)
      cubeValue *= 2
      phase = 'roll'
      notice = `Удвоение принято. ${name(player)} бросают кости.`
      record(`${actor(opponent(offerer))}: удвоение принято, куб ×${cubeValue}.`, 'cube')
      offerer = null
      playSound('cube')
      render()
      break
    case 'pass':
      if (phase !== 'offer' || !offerer) break
      score[offerer] += cubeValue
      winner = offerer
      phase = 'over'
      notice = `${name(opponent(offerer))} отказались от удвоения. ${name(offerer)} получают ${cubeValue} ${pointWord(cubeValue)}.`
      record(`${actor(opponent(offerer))}: отказ от удвоения. ${actor(offerer)}: +${cubeValue} ${pointWord(cubeValue)}.`, 'result')
      offerer = null
      playSound('win')
      render()
      break
    case 'rules': rulesOpen = true; render(); document.querySelector<HTMLButtonElement>('.modal-close')?.focus(); break
    case 'close-rules': rulesOpen = false; render(); document.querySelector<HTMLButtonElement>('[data-action="rules"]')?.focus(); break
  }
}

function queueBotStep(): void {
  if (botTimer !== undefined) window.clearTimeout(botTimer)
  if (!isAutomated() || paused || rulesOpen || botBusy || diceAnimator.isRolling()) return
  const delay = phase === 'over' ? 2200 : mode === 'demo' ? 650 : 500
  botTimer = window.setTimeout(runBotStep, delay)
}

function requestBotPlay(): void {
  const id = ++botRequestId
  const version = gameVersion
  const currentBoard = board
  const currentPlayer = player
  const currentDice = [...remaining]
  botBusy = true
  notice = `${name(player)}: бот рассчитывает ход.`
  render()

  let settled = false
  const receive = (playMoves: Move[]) => {
    if (settled || id !== botRequestId || version !== gameVersion) return
    settled = true
    botBusy = false
    const legal = sequences.some(sequence => sequence.length === playMoves.length && sequence.every((move, index) => sameMove(move, playMoves[index])))
    botPlan = legal ? playMoves : [...(sequences[0] ?? [])]
    notice = 'Бот выбрал ход.'
    render()
  }
  const fallback = () => {
    botWorker?.terminate()
    botWorker = null
    window.setTimeout(() => {
      try { receive(chooseBotPlay(currentBoard, currentPlayer, currentDice)) }
      catch { receive(sequences[0] ?? []) }
    }, 0)
  }

  try {
    botWorker ??= new Worker(new URL('./bot.worker.ts', import.meta.url), { type: 'module' })
    botWorker.onmessage = (event: MessageEvent<{ id: number; play?: Move[]; error?: string }>) => {
      if (event.data.id !== id) return
      if (event.data.error || !event.data.play) fallback()
      else receive(event.data.play)
    }
    botWorker.onerror = fallback
    botWorker.postMessage({ id, board: currentBoard, player: currentPlayer, dice: currentDice })
  } catch { fallback() }
}

function runBotStep(): void {
  if (!isAutomated() || paused || rulesOpen || botBusy || diceAnimator.isRolling()) return
  if (phase === 'opening') { openingRoll(); return }
  if (phase === 'over') { startGame(); return }
  if (phase === 'offer') {
    activateAction(shouldAcceptDouble(board, opponent(offerer!)) ? 'accept' : 'pass')
    return
  }
  if (phase === 'roll') {
    if ((cubeOwner === null || cubeOwner === player) && shouldOfferDouble(board, player, cubeValue)) activateAction('double')
    else roll()
    return
  }
  if (firstMoves(sequences).length === 0) { finishTurn(); return }
  const next = botPlan.shift()
  if (next) play(next)
  else requestBotPlay()
}

app.addEventListener('change', event => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('[data-mode]')
  if (!select || (select.value !== 'local' && select.value !== 'bot' && select.value !== 'demo')) return
  mode = select.value
  paused = false
  score = { light: 0, dark: 0 }
  logEntries = []
  nextLogId = 0
  sessionId = newSessionId()
  gameNumber = 0
  startGame()
})

app.addEventListener('click', event => {
  const target = event.target as HTMLElement
  const actionElement = target.closest<HTMLElement>('[data-action]')
  if (actionElement) {
    if (actionElement.dataset.action === 'close-rules' && target !== actionElement && actionElement.classList.contains('modal-backdrop')) return
    activateAction(actionElement.dataset.action!)
    return
  }
  if (phase !== 'move' || isBot(player)) return
  const moveElement = target.closest<HTMLElement>('[data-move]')
  if (moveElement) { const move = moveOptions()[Number(moveElement.dataset.move)]; if (move) play(move); return }
  const offElement = target.closest<HTMLElement>('[data-destination="off"]')
  if (offElement) { const options = moveOptions().filter(candidate => candidate.to === 'off'); if (options.length === 1) play(options[0]); else if (options.length > 1) { notice = 'Выберите нужную кость в списке доступных ходов.'; render() } return }
  const barElement = target.closest<HTMLElement>('[data-bar]')
  if (barElement && canSelect('bar')) { selected = 'bar'; render(); return }
  const pointElement = target.closest<HTMLElement>('[data-point]')
  if (!pointElement) return
  const point = Number(pointElement.dataset.point)
  const destinationMove = moveOptions().filter(candidate => candidate.to === point)
  if (destinationMove.length === 1) { play(destinationMove[0]); return }
  if (destinationMove.length > 1) { notice = 'Выберите нужную кость в списке доступных ходов.'; render(); return }
  if (canSelect(point)) { selected = point; render() }
})

bindBoardDragAndDrop(app, {
  canDrag: from => canSelect(from),
  legalMoves: () => firstMoves(sequences),
  onMove: move => play(move),
  onAmbiguous: from => {
    selected = from
    notice = 'Выберите нужную кость в списке доступных ходов.'
    render()
  },
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && rulesOpen) { rulesOpen = false; render(); document.querySelector<HTMLButtonElement>('[data-action="rules"]')?.focus() }
  if (event.key === 'Tab' && rulesOpen) {
    const focusable = Array.from(document.querySelectorAll<HTMLButtonElement>('.rules-modal button'))
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
})

startGame()
