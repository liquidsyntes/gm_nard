import { boardDiceSlots, pipHtml } from './board-dice.ts'
import type { BoardRoll, DiceAnimator } from './board-dice.ts'
import type { Board, Destination, Move, Origin, Player } from './engine.ts'

export interface BoardViewOptions {
  board: Board
  selected: Origin | null
  legalMoves: Move[]
  interactive: boolean
  flipped: boolean
  lastMoves: Move[]
  roll: BoardRoll | null
  remaining: number[]
  inMovePhase: boolean
  diceAnimator: DiceAnimator
  labelForSide?: (side: Player) => string
}

export interface BoardDragHooks {
  canDrag: (from: Origin) => boolean
  legalMoves: () => Move[]
  onMove: (move: Move) => void
  onAmbiguous: (from: Origin) => void
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
const defaultSideName = (side: Player) => side === 'light' ? 'Светлые' : 'Тёмные'

export function renderBoard(options: BoardViewOptions): string {
  const { board, selected, legalMoves, interactive, flipped, lastMoves, roll, remaining, inMovePhase, diceAnimator, labelForSide } = options
  const rolling = diceAnimator.isRolling()
  const sideLabel = (side: Player) => labelForSide ? labelForSide(side) : defaultSideName(side)
  const canSelect = (from: Origin) => interactive && !rolling && legalMoves.some(move => move.from === from)
  const selectedMoves = selected === null ? [] : legalMoves.filter(move => move.from === selected)
  const lastFrom = new Set<Origin>(lastMoves.map(move => move.from))
  const lastTo = new Set<Destination>(lastMoves.map(move => move.to))

  const checkerStack = (count: number, side: Player, point: number): string => {
    if (!count) return ''
    const shown = Math.min(count, 5)
    return `<span class="stack ${side}" draggable="${canSelect(point)}" data-origin="${point}" aria-hidden="true">${Array.from({ length: shown }, () => '<span class="checker"></span>').join('')}${count > 5 ? `<span class="stack-count">${count}</span>` : ''}</span>`
  }

  const pointHtml = (point: number, row: 'top' | 'bottom'): string => {
    const count = board.points[point]
    const side: Player = count > 0 ? 'light' : 'dark'
    const target = selectedMoves.some(move => move.to === point)
    const source = selected === point
    const classes = [
      'point',
      row,
      point % 2 ? 'point-warm' : 'point-cool',
      target ? 'possible' : '',
      source ? 'selected' : '',
      lastFrom.has(point) ? 'last-from' : '',
      lastTo.has(point) ? 'last-to' : '',
    ].filter(Boolean).join(' ')
    const label = `Пункт ${point + 1}: ${count ? `${Math.abs(count)} фишек, ${defaultSideName(side).toLowerCase()}` : 'пусто'}${target ? ', возможный ход' : ''}`
    return `<button class="${classes}" data-point="${point}" data-destination="${point}" aria-label="${label}"><span class="triangle"></span><span class="point-number">${point + 1}</span>${checkerStack(Math.abs(count), side, point)}</button>`
  }

  const rowHtml = (points: number[], row: 'top' | 'bottom'): string =>
    `<div class="board-row ${row}">${points.slice(0, 6).map(point => pointHtml(point, row)).join('')}<div class="bar-spacer" aria-hidden="true"></div>${points.slice(6).map(point => pointHtml(point, row)).join('')}</div>`

  const boardDiceHtml = (side: Player): string => {
    const { slots, isDouble } = boardDiceSlots(roll, side, remaining, inMovePhase)
    if (!slots.length) return ''
    const leftCount = slots.filter(slot => !slot.used).length
    const caption = roll?.kind === 'opening'
      ? `${defaultSideName(side)} · ${slots[0].value}`
      : isDouble
        ? `${defaultSideName(side)} · ${slots[0].value}+${slots[0].value}${inMovePhase && !rolling ? ` (×${leftCount})` : ''}`
        : `${defaultSideName(side)} · ${slots[0].value} + ${slots[1].value}`
    const ariaValues = isDouble ? `${slots[0].value} и ${slots[0].value}, дубль` : slots.map(slot => slot.value).join(' и ')
    const diceHtml = slots.map(slot =>
      `<span class="board-die ${!rolling && slot.used ? 'used' : ''}" data-board-die="${slot.index}">${pipHtml(diceAnimator.valueFor(slot.index, slot.value))}</span>`,
    ).join('')
    return `<div class="board-dice ${side} ${isDouble ? 'double' : ''} ${rolling ? 'rolling' : ''}" role="status" aria-label="${escapeHtml(sideLabel(side))}: выпало ${ariaValues}"><span class="board-dice-caption">${caption}</span><span class="board-dice-pair" aria-hidden="true">${diceHtml}</span></div>`
  }

  const topPoints = flipped ? [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] : [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
  const bottomPoints = flipped ? [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] : [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
  const leftOffSide: Player = flipped ? 'light' : 'dark'
  const rightOffSide: Player = flipped ? 'dark' : 'light'
  const leftDiceSide: Player = flipped ? 'dark' : 'light'
  const rightDiceSide: Player = flipped ? 'light' : 'dark'
  const barPossible = canSelect('bar')
  const barClasses = [
    'bar-zone',
    barPossible ? 'possible' : '',
    selected === 'bar' ? 'selected' : '',
    lastFrom.has('bar') ? 'last-from' : '',
  ].filter(Boolean).join(' ')

  return `<div class="board-frame"><div class="board-surface ${flipped ? 'flipped' : ''}">
    ${rowHtml(topPoints, 'top')}
    <div class="board-middle">
      <div class="rail-half"><div class="rail-label">ВНЕ ИГРЫ <strong>${board.off[leftOffSide]}</strong><span class="rail-token ${leftOffSide}"></span></div>${boardDiceHtml(leftDiceSide)}</div>
      <button class="${barClasses}" draggable="${barPossible}" data-origin="bar" data-bar="true" aria-label="Бар: ${board.bar.light} светлых, ${board.bar.dark} тёмных фишек"><span class="bar-title">БАР</span><span class="bar-group dark">${Array.from({ length: Math.min(board.bar.dark, 4) }, () => '<span class="mini-checker dark"></span>').join('')}${board.bar.dark > 4 ? `<b>+${board.bar.dark - 4}</b>` : ''}</span><span class="bar-group light">${Array.from({ length: Math.min(board.bar.light, 4) }, () => '<span class="mini-checker light"></span>').join('')}${board.bar.light > 4 ? `<b>+${board.bar.light - 4}</b>` : ''}</span></button>
      <div class="rail-half"><div class="rail-label right"><span class="rail-token ${rightOffSide}"></span>ВНЕ ИГРЫ <strong>${board.off[rightOffSide]}</strong></div>${boardDiceHtml(rightDiceSide)}</div>
    </div>
    ${rowHtml(bottomPoints, 'bottom')}
  </div></div>`
}

export function bindBoardDragAndDrop(root: HTMLElement, hooks: BoardDragHooks): void {
  root.addEventListener('dragstart', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-origin]')
    if (!target) return
    const raw = target.dataset.origin
    const origin: Origin | null = raw === 'bar' ? 'bar' : raw !== undefined && raw !== '' ? Number(raw) : null
    if (origin === null || !hooks.canDrag(origin)) { event.preventDefault(); return }
    event.dataTransfer?.setData('text/plain', String(origin))
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  })
  root.addEventListener('dragover', event => {
    if ((event.target as HTMLElement).closest('[data-destination]')) event.preventDefault()
  })
  root.addEventListener('drop', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-destination]')
    if (!target) return
    const raw = event.dataTransfer?.getData('text/plain')
    if (!raw) return
    const from: Origin = raw === 'bar' ? 'bar' : Number(raw)
    if (!hooks.canDrag(from)) return
    event.preventDefault()
    const to: Destination = target.dataset.destination === 'off' ? 'off' : Number(target.dataset.destination)
    const matches = hooks.legalMoves().filter(move => move.from === from && move.to === to)
    if (matches.length === 1) hooks.onMove(matches[0])
    else if (matches.length > 1) hooks.onAmbiguous(from)
  })
}
