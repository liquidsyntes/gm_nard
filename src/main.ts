import './style.css'
import { applyMove, firstMoves, initialBoard, legalSequences, opponent, resultKind, resultPoints, sameMove } from './engine.ts'
import type { Board, Destination, Move, Origin, Player } from './engine.ts'

type Phase = 'opening' | 'roll' | 'move' | 'offer' | 'over'
interface Snapshot { board: Board; sequences: Move[][]; remaining: number[] }

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

const app = document.querySelector<HTMLDivElement>('#app')!
const name = (side: Player) => side === 'light' ? 'Светлые' : 'Тёмные'
const dieLabel = (value: number) => ['','⚀','⚁','⚂','⚃','⚄','⚅'][value]
const pointWord = (value: number) => value % 100 >= 11 && value % 100 <= 14 ? 'очков' : value % 10 === 1 ? 'очко' : value % 10 >= 2 && value % 10 <= 4 ? 'очка' : 'очков'

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
  return phase === 'move' && firstMoves(sequences).some(move => move.from === from)
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
    <span class="player-symbol ${side}"></span><div><strong>${name(side)}</strong><small>${side === 'light' ? 'Кремовые фишки' : 'Графитовые фишки'}</small></div>
    <span class="score">${score[side]}<small>очк.</small></span>
  </div>`
}

function actionHtml(): string {
  if (phase === 'opening') return '<button class="primary-button" data-action="open">Определить первый ход <span>↗</span></button>'
  if (phase === 'offer') return `<div class="offer-actions"><button class="primary-button" data-action="accept">Принять ×${cubeValue * 2}</button><button class="secondary-button" data-action="pass">Отказаться</button></div>`
  if (phase === 'roll') return `<button class="primary-button" data-action="roll">Бросить кости <span>↗</span></button>${cubeOwner === null || cubeOwner === player ? `<button class="secondary-button" data-action="double">Предложить удвоение</button>` : ''}`
  if (phase === 'over') return '<button class="primary-button" data-action="new">Новая партия <span>↗</span></button>'
  const completed = firstMoves(sequences).length === 0
  return `${completed ? '<button class="primary-button" data-action="finish">Завершить ход <span>↗</span></button>' : '<p class="action-hint">Выберите фишку и пункт назначения</p>'}${history.length ? '<button class="secondary-button" data-action="undo">Отменить ход</button>' : ''}`
}

function optionsHtml(): string {
  const options = moveOptions()
  if (phase !== 'move' || !options.length) return ''
  return `<div class="move-options"><span class="eyebrow">Доступные ходы</span><div class="option-list">${options.map((move, index) => `<button data-move="${index}"><span>${formatDestination(move.to)}</span><b>${dieLabel(move.die)} <small>${move.die}</small></b></button>`).join('')}</div></div>`
}

function render(): void {
  const barOption = moveOptions().some(move => move.from === 'bar')
  const offOption = moveOptions().some(move => move.to === 'off')
  const phaseLabel = phase === 'opening' ? 'Подготовка' : phase === 'offer' ? 'Решение за соперником' : phase === 'over' ? 'Партия окончена' : phase === 'roll' ? 'Ваш бросок' : firstMoves(sequences).length ? 'Ваш ход' : 'Ход завершён'
  app.innerHTML = `<div class="shell">
    <header class="site-header"><div class="brand"><img class="brand-mark" src="/die-logo.svg" alt="" /><div><strong>NARD</strong><small>КОРОТКИЕ НАРДЫ</small></div></div><div class="header-right"><span class="mode-pill"><span></span> ИГРА ВДВОЁМ</span><button class="text-button" data-action="rules">Правила <span>↗</span></button></div></header>
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
      <aside class="sidebar"><div class="sidebar-top"><span class="eyebrow">ПАРТИЯ <b>01</b></span><button class="icon-button" data-action="new" title="Новая партия" aria-label="Новая партия">↻</button></div>
        <div class="players">${playerCard('light')}<div class="versus">VS <span>•</span> ${phase === 'over' ? 'ФИНИШ' : 'ХОД'}</div>${playerCard('dark')}</div>
        <div class="turn-panel" aria-live="polite"><span class="eyebrow">${phaseLabel.toUpperCase()}</span><strong>${phase === 'offer' ? name(opponent(offerer!)) : phase === 'over' ? `${name(winner!)} победили` : phase === 'opening' ? 'Кто начнёт?' : name(player)}</strong><p>${notice}</p></div>
        <div class="dice-panel"><div class="dice-title"><span class="eyebrow">ИГРОВЫЕ КОСТИ</span><span class="cube">КУБ <b>×${cubeValue}</b>${cubeOwner ? ` · ${name(cubeOwner)}` : ''}</span></div><div class="dice">${diceHtml()}</div></div>
        ${optionsHtml()}<div class="actions">${actionHtml()}</div>
        <div class="sidebar-bottom"><span class="tiny-diamond">◇</span> Первый, кто выведет все 15 фишек, побеждает.</div>
      </aside>
    </main>
    <footer class="site-footer"><span>© NARD / ВЕБ-ИГРА</span><span>СДЕЛАНО ДЛЯ ИГРЫ ВМЕСТЕ</span></footer>
    ${rulesOpen ? `<div class="modal-backdrop" data-action="close-rules"><section class="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-title"><button class="modal-close" data-action="close-rules" aria-label="Закрыть правила">×</button><span class="eyebrow">КОРОТКИЕ НАРДЫ</span><h2 id="rules-title">Как играть</h2><p>Каждый игрок ведёт 15 фишек навстречу сопернику, собирает их в своём доме и выводит с доски. Светлые идут от пункта 24 к 1, тёмные в обратную сторону.</p><ol><li>Числа на костях играются как отдельные ходы. Дубль даёт четыре одинаковых хода. Нужно использовать максимум доступных костей; если доступна только одна из двух, играется старшая.</li><li>Пункт с двумя чужими фишками закрыт. Одиночную чужую фишку можно сбить на бар. Пока на баре есть свои фишки, сначала введите их в игру.</li><li>Выводить фишки можно, когда все свои фишки находятся в доме. Если нужный пункт пуст, сначала двигайте фишку с более дальнего пункта. Если таких нет, выводите с самого дальнего занятого.</li><li>Победа стоит одно очко, марс два, кокс три. Куб удвоения меняет стоимость партии и предлагается до броска.</li></ol><button class="primary-button" data-action="close-rules">Понятно</button></section></div>` : ''}
  </div>`
}

function startGame(): void {
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
  phase = 'move'
  notice = `Светлые выбросили ${light}, тёмные ${dark}. ${name(player)} начинают и играют оба числа.`
  render()
}

function roll(): void {
  const first = randomDie()
  const second = randomDie()
  dice = first === second ? [first, first, first, first] : [first, second]
  remaining = [...dice]
  sequences = legalSequences(board, player, remaining)
  history = []
  selected = board.bar[player] > 0 ? 'bar' : null
  phase = 'move'
  notice = sequences.length ? first === second ? `Дубль ${first}:${second}. Можно сделать четыре хода.` : `Выпало ${first} и ${second}. Выберите фишку.` : 'Допустимых ходов нет. Передайте ход сопернику.'
  render()
}

function play(move: Move): void {
  if (phase !== 'move' || !firstMoves(sequences).some(candidate => sameMove(candidate, move))) return
  history.push({ board, sequences, remaining: [...remaining] })
  board = applyMove(board, player, move)
  sequences = sequences.filter(sequence => sameMove(sequence[0], move)).map(sequence => sequence.slice(1))
  remaining.splice(remaining.indexOf(move.die), 1)
  selected = board.bar[player] > 0 ? 'bar' : null
  notice = board.off[player] === 15 ? 'Все фишки выведены. Завершите ход, чтобы зафиксировать победу.' : firstMoves(sequences).length ? 'Продолжайте ход.' : 'Все доступные ходы сыграны. Завершите ход.'
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
  } else {
    player = opponent(player)
    phase = 'roll'
    notice = 'Бросьте кости или предложите удвоение до броска.'
    dice = []
    remaining = []
    history = []
    sequences = []
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
    case 'undo': {
      if (phase !== 'move') break
      const snapshot = history.pop()
      if (!snapshot) break
      board = snapshot.board
      sequences = snapshot.sequences
      remaining = snapshot.remaining
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
      render()
      break
    case 'accept':
      if (phase !== 'offer' || !offerer) break
      cubeOwner = opponent(offerer)
      cubeValue *= 2
      phase = 'roll'
      notice = `Удвоение принято. ${name(player)} бросают кости.`
      offerer = null
      render()
      break
    case 'pass':
      if (phase !== 'offer' || !offerer) break
      score[offerer] += cubeValue
      winner = offerer
      phase = 'over'
      notice = `${name(opponent(offerer))} отказались от удвоения. ${name(offerer)} получают ${cubeValue} ${pointWord(cubeValue)}.`
      offerer = null
      render()
      break
    case 'rules': rulesOpen = true; render(); document.querySelector<HTMLButtonElement>('.modal-close')?.focus(); break
    case 'close-rules': rulesOpen = false; render(); document.querySelector<HTMLButtonElement>('[data-action="rules"]')?.focus(); break
  }
}

app.addEventListener('click', event => {
  const target = event.target as HTMLElement
  const actionElement = target.closest<HTMLElement>('[data-action]')
  if (actionElement) {
    if (actionElement.dataset.action === 'close-rules' && target !== actionElement && actionElement.classList.contains('modal-backdrop')) return
    activateAction(actionElement.dataset.action!)
    return
  }
  if (phase !== 'move') return
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
  if (!target || phase !== 'move') return
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

render()
