import './style.css'
import { applyMove, firstMoves, initialBoard, legalSequences, opponent, resultKind, resultPoints, sameMove } from './engine.ts'
import { chooseBotPlay, shouldAcceptDouble, shouldOfferDouble } from './bot.ts'
import type { Board, Destination, Move, Origin, Player } from './engine.ts'

type Phase = 'opening' | 'roll' | 'move' | 'offer' | 'over'
type Mode = 'local' | 'bot' | 'demo'
type LogKind = 'system' | 'roll' | 'move' | 'cube' | 'result'
interface LogEntry { id: number; time: string; text: string; kind: LogKind }
interface Snapshot { board: Board; sequences: Move[][]; remaining: number[]; logId: number; move: Move }

let mode: Mode = 'local'
let paused = false
let board = initialBoard()
let phase: Phase = 'opening'
let player: Player = 'light'
let dice: number[] = []
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
  return phase === 'move' && !isBot(player) && firstMoves(sequences).some(move => move.from === from)
}

function moveOptions(): Move[] {
  return selected === null ? [] : firstMoves(sequences).filter(move => move.from === selected)
}

function checkerStack(count: number, side: Player, point: number): string {
  if (!count) return ''
  const shown = Math.min(count, 5)
  return `<span class="stack ${side}" draggable="${canSelect(point)}" data-origin="${point}" aria-hidden="true">${Array.from({ length: shown }, () => '<span class="checker"></span>').join('')}${count > 5 ? `<span class="stack-count">${count}</span>` : ''}</span>`
}

function pointHtml(point: number, row: 'top' | 'bottom'): string {
  const count = board.points[point]
  const side = count > 0 ? 'light' : 'dark'
  const options = moveOptions()
  const target = options.some(move => move.to === point)
  const source = selected === point
  return `<button class="point ${row} ${point % 2 ? 'point-warm' : 'point-cool'} ${target ? 'possible' : ''} ${source ? 'selected' : ''}" data-point="${point}" data-destination="${point}" aria-label="Пункт ${point + 1}: ${count ? `${Math.abs(count)} фишек, ${name(side as Player).toLowerCase()}` : 'пусто'}${target ? ', возможный ход' : ''}">
    <span class="triangle"></span><span class="point-number">${point + 1}</span>${checkerStack(Math.abs(count), side as Player, point)}
  </button>`
}

function rowHtml(points: number[], row: 'top' | 'bottom'): string {
  return `<div class="board-row ${row}">${points.slice(0, 6).map(point => pointHtml(point, row)).join('')}<div class="bar-spacer" aria-hidden="true"></div>${points.slice(6).map(point => pointHtml(point, row)).join('')}</div>`
}

function diceHtml(): string {
  if (dice.length === 0) return '<span class="dice-empty">Кости ждут броска</span>'
  const available = [...remaining]
  return dice.map(die => {
    const index = available.indexOf(die)
    const used = index < 0
    if (!used) available.splice(index, 1)
    return `<span class="die ${used ? 'used' : ''}" aria-label="${die}${used ? ', сыграна' : ''}">${dieLabel(die)}</span>`
  }).join('')
}

function playerCard(side: Player): string {
  return `<div class="player-card ${player === side && phase !== 'over' ? 'active' : ''}">
    <span class="player-symbol ${side}"></span><div><strong>${name(side)} ${isBot(side) ? '<em>БОТ</em>' : ''}</strong><small>${side === 'light' ? 'Кремовые фишки' : 'Графитовые фишки'}</small></div>
    <span class="score">${score[side]}<small>очк.</small></span>
  </div>`
}

function actionHtml(): string {
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
  const barOption = moveOptions().some(move => move.from === 'bar')
  const offOption = moveOptions().some(move => move.to === 'off')
  const phaseLabel = phase === 'opening' ? 'Подготовка' : phase === 'offer' ? 'Решение за соперником' : phase === 'over' ? 'Партия окончена' : phase === 'roll' ? 'Ваш бросок' : firstMoves(sequences).length ? 'Ваш ход' : 'Ход завершён'
  app.innerHTML = `<div class="shell">
    <header class="site-header"><div class="brand"><img class="brand-mark" src="${BASE}die-logo.svg" alt="" /><div><strong>NARD</strong><small>КОРОТКИЕ НАРДЫ</small></div></div><div class="header-right"><span class="mode-pill"><span></span> ${mode === 'local' ? 'ИГРА ВДВОЁМ' : mode === 'bot' ? 'ИГРА С БОТОМ' : 'БОТ VS БОТ'}</span><a class="text-button" href="${BASE}online.html">Онлайн ↗</a><button class="text-button" data-action="rules">Правила <span>↗</span></button></div></header>
    <main class="layout">
      <section class="game-area" aria-label="Игровое поле">
        <div class="board-head"><div><span class="eyebrow">КЛАССИЧЕСКАЯ ПАРТИЯ</span><h1>Игра начинается здесь.</h1></div><div class="board-head-meta"><span>24 ПУНКТА</span><i></i><span>15 ФИШЕК</span></div></div>
        <div class="board-frame"><div class="board-surface">
          ${rowHtml([12,13,14,15,16,17,18,19,20,21,22,23], 'top')}
          <div class="board-middle"><div class="rail-label">ВНЕ ИГРЫ <strong>${board.off.dark}</strong><span class="rail-token dark"></span></div><button class="bar-zone ${barOption ? 'possible' : ''} ${selected === 'bar' ? 'selected' : ''}" data-bar="true" aria-label="Бар: ${board.bar.light} светлых, ${board.bar.dark} тёмных фишек"><span class="bar-title">БАР</span><span class="bar-group dark">${Array.from({length: Math.min(board.bar.dark, 4)}, () => '<span class="mini-checker dark"></span>').join('')}${board.bar.dark > 4 ? `<b>+${board.bar.dark - 4}</b>` : ''}</span><span class="bar-group light">${Array.from({length: Math.min(board.bar.light, 4)}, () => '<span class="mini-checker light"></span>').join('')}${board.bar.light > 4 ? `<b>+${board.bar.light - 4}</b>` : ''}</span></button><div class="rail-label right"><span class="rail-token light"></span>ВНЕ ИГРЫ <strong>${board.off.light}</strong></div></div>
          ${rowHtml([11,10,9,8,7,6,5,4,3,2,1,0], 'bottom')}
        </div></div>
        <div class="board-footer"><button class="off-target ${offOption ? 'possible' : ''}" data-destination="off"><span class="target-icon">◎</span><span>ВЫВЕСТИ ФИШКУ</span></button><span>Светлые движутся от 24 к 1 <span class="footer-arrow">↘</span></span></div>
      </section>
      <aside class="sidebar"><div class="sidebar-top"><span class="eyebrow">КЛАССИЧЕСКАЯ ИГРА</span><button class="icon-button" data-action="new" title="Новая партия" aria-label="Новая партия">↻</button></div>
        <label class="mode-control"><span class="eyebrow">РЕЖИМ ИГРЫ</span><select aria-label="Режим игры" data-mode><option value="local" ${mode === 'local' ? 'selected' : ''}>Два игрока</option><option value="bot" ${mode === 'bot' ? 'selected' : ''}>Против бота</option><option value="demo" ${mode === 'demo' ? 'selected' : ''}>Бот против бота</option></select></label>
        <div class="players">${playerCard('light')}<div class="versus">VS <span>•</span> ${phase === 'over' ? 'ФИНИШ' : 'ХОД'}</div>${playerCard('dark')}</div>
        <div class="turn-panel" aria-live="polite"><span class="eyebrow">${phaseLabel.toUpperCase()}</span><strong>${phase === 'offer' ? name(opponent(offerer!)) : phase === 'over' ? `${name(winner!)} победили` : phase === 'opening' ? 'Кто начнёт?' : name(player)}</strong><p>${notice}</p></div>
        <div class="dice-panel"><div class="dice-title"><span class="eyebrow">ИГРОВЫЕ КОСТИ</span><span class="cube">КУБ <b>×${cubeValue}</b>${cubeOwner ? ` · ${name(cubeOwner)}` : ''}</span></div><div class="dice">${diceHtml()}</div></div>
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
  gameVersion++
  gameNumber++
  botPlan = []
  botBusy = false
  board = initialBoard()
  phase = 'opening'
  player = 'light'
  dice = []
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
  dice = [light, dark]
  remaining = [...dice]
  sequences = legalSequences(board, player, remaining)
  botPlan = []
  phase = 'move'
  notice = `Светлые выбросили ${light}, тёмные ${dark}. ${name(player)} начинают и играют оба числа.`
  record(`Первый бросок: светлые ${light}, тёмные ${dark}. Начинают ${name(player).toLowerCase()}.`, 'roll')
  render()
}

function roll(): void {
  const first = randomDie()
  const second = randomDie()
  dice = first === second ? [first, first, first, first] : [first, second]
  remaining = [...dice]
  sequences = legalSequences(board, player, remaining)
  botPlan = []
  history = []
  selected = board.bar[player] > 0 ? 'bar' : null
  phase = 'move'
  notice = sequences.length ? first === second ? `Дубль ${first}:${second}. Можно сделать четыре хода.` : `Выпало ${first} и ${second}. Выберите фишку.` : 'Допустимых ходов нет. Передайте ход сопернику.'
  record(`${actor(player)}: бросок ${first} и ${second}${first === second ? ', дубль' : ''}.`, 'roll')
  render()
}

function play(move: Move): void {
  if (phase !== 'move' || !firstMoves(sequences).some(candidate => sameMove(candidate, move))) return
  history.push({ board, sequences, remaining: [...remaining], logId: nextLogId, move })
  const hit = move.to !== 'off' && board.points[move.to] === (player === 'light' ? -1 : 1)
  board = applyMove(board, player, move)
  sequences = sequences.filter(sequence => sameMove(sequence[0], move)).map(sequence => sequence.slice(1))
  remaining.splice(remaining.indexOf(move.die), 1)
  selected = board.bar[player] > 0 ? 'bar' : null
  notice = board.off[player] === 15 ? 'Все фишки выведены. Завершите ход, чтобы зафиксировать победу.' : firstMoves(sequences).length ? 'Продолжайте ход.' : 'Все доступные ходы сыграны. Завершите ход.'
  record(`${actor(player)}: ${moveText(move)}${hit ? ', сбита фишка соперника' : ''}.`, 'move')
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
  } else {
    if (history.length === 0) record(`${actor(player)}: пропуск хода, нет допустимых перемещений.`)
    player = opponent(player)
    phase = 'roll'
    notice = 'Бросьте кости или предложите удвоение до броска.'
    dice = []
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
    case 'pause': if (mode === 'demo') { paused = !paused; record(paused ? 'Автоматическая игра остановлена.' : 'Автоматическая игра продолжена.'); render() } break
    case 'undo': {
      if (phase !== 'move') break
      const snapshot = history.pop()
      if (!snapshot) break
      board = snapshot.board
      sequences = snapshot.sequences
      remaining = snapshot.remaining
      logEntries = logEntries.filter(entry => entry.id <= snapshot.logId)
      record(`${actor(player)}: отмена хода ${moveText(snapshot.move)}.`)
      selected = null
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
      render()
      break
    case 'rules': rulesOpen = true; render(); document.querySelector<HTMLButtonElement>('.modal-close')?.focus(); break
    case 'close-rules': rulesOpen = false; render(); document.querySelector<HTMLButtonElement>('[data-action="rules"]')?.focus(); break
  }
}

function queueBotStep(): void {
  if (botTimer !== undefined) window.clearTimeout(botTimer)
  if (!isAutomated() || paused || rulesOpen || botBusy) return
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
  const receive = (play: Move[]) => {
    if (settled || id !== botRequestId || version !== gameVersion) return
    settled = true
    botBusy = false
    const legal = sequences.some(sequence => sequence.length === play.length && sequence.every((move, index) => sameMove(move, play[index])))
    botPlan = legal ? play : [...(sequences[0] ?? [])]
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
  if (!isAutomated() || paused || rulesOpen || botBusy) return
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

app.addEventListener('dragstart', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-origin]')
  if (!target || !canSelect(Number(target.dataset.origin))) { event.preventDefault(); return }
  event.dataTransfer?.setData('text/plain', target.dataset.origin!)
})
app.addEventListener('dragover', event => { if ((event.target as HTMLElement).closest('[data-destination]')) event.preventDefault() })
app.addEventListener('drop', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-destination]')
  if (!target || phase !== 'move' || isBot(player)) return
  event.preventDefault()
  const from = Number(event.dataTransfer?.getData('text/plain'))
  const to = target.dataset.destination === 'off' ? 'off' : Number(target.dataset.destination)
  const matches = firstMoves(sequences).filter(move => move.from === from && move.to === to)
  if (matches.length === 1) play(matches[0])
  else if (matches.length > 1) { selected = from; notice = 'Выберите нужную кость в списке доступных ходов.'; render() }
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
