export type Player = 'light' | 'dark'
export type Origin = number | 'bar'
export type Destination = number | 'off'

export interface Board {
  // Positive points contain light checkers, negative points contain dark checkers.
  points: number[]
  bar: Record<Player, number>
  off: Record<Player, number>
}

export interface Move {
  from: Origin
  to: Destination
  die: number
}

export type ResultKind = 'single' | 'gammon' | 'backgammon'

export const opponent = (player: Player): Player => player === 'light' ? 'dark' : 'light'
const direction = (player: Player) => player === 'light' ? -1 : 1
const sign = (player: Player) => player === 'light' ? 1 : -1
const owns = (count: number, player: Player) => count * sign(player) > 0
const isHome = (point: number, player: Player) => player === 'light' ? point <= 5 : point >= 18

export function initialBoard(): Board {
  const points = Array<number>(24).fill(0)
  points[23] = 2
  points[12] = 5
  points[7] = 3
  points[5] = 5
  points[0] = -2
  points[11] = -5
  points[16] = -3
  points[18] = -5
  return { points, bar: { light: 0, dark: 0 }, off: { light: 0, dark: 0 } }
}

export function canBearOff(board: Board, player: Player): boolean {
  return board.bar[player] === 0 && board.points.every((count, index) => !owns(count, player) || isHome(index, player))
}

function entryPoint(player: Player, die: number): number {
  return player === 'light' ? 24 - die : die - 1
}

function isOpen(board: Board, point: number, player: Player): boolean {
  return board.points[point] * sign(player) >= -1
}

export function movesForDie(board: Board, player: Player, die: number): Move[] {
  if (board.bar[player] > 0) {
    const to = entryPoint(player, die)
    return isOpen(board, to, player) ? [{ from: 'bar', to, die }] : []
  }

  const moves: Move[] = []
  const bearing = canBearOff(board, player)
  for (let from = 0; from < 24; from++) {
    if (!owns(board.points[from], player)) continue
    const to = from + direction(player) * die
    if (to >= 0 && to < 24) {
      if (isOpen(board, to, player)) moves.push({ from, to, die })
      continue
    }
    if (!bearing) continue
    const distance = player === 'light' ? from + 1 : 24 - from
    if (die === distance || (die > distance && !board.points.some((count, index) => owns(count, player) && isHome(index, player) && (player === 'light' ? index > from : index < from)))) {
      moves.push({ from, to: 'off', die })
    }
  }
  return moves
}

export function applyMove(board: Board, player: Player, move: Move): Board {
  if (!movesForDie(board, player, move.die).some(candidate => sameMove(candidate, move))) {
    throw new Error('Недопустимый ход')
  }
  const next: Board = {
    points: [...board.points],
    bar: { ...board.bar },
    off: { ...board.off },
  }
  if (move.from === 'bar') next.bar[player]--
  else next.points[move.from] -= sign(player)

  if (move.to === 'off') next.off[player]++
  else {
    if (next.points[move.to] === -sign(player)) {
      next.points[move.to] = 0
      next.bar[opponent(player)]++
    }
    next.points[move.to] += sign(player)
  }
  return next
}

export function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die
}

// Generate complete plays, then keep only those that use the maximum possible dice.
// This also enforces the higher-die rule when exactly one of two dice can be played.
export function legalSequences(board: Board, player: Player, dice: number[]): Move[][] {
  if (dice.length === 0) return []
  const plays: Move[][] = []
  const visit = (position: Board, remaining: number[], prefix: Move[]) => {
    let extended = false
    for (const die of new Set(remaining)) {
      for (const move of movesForDie(position, player, die)) {
        extended = true
        const rest = [...remaining]
        rest.splice(rest.indexOf(die), 1)
        visit(applyMove(position, player, move), rest, [...prefix, move])
      }
    }
    if (!extended) plays.push(prefix)
  }
  visit(board, dice, [])
  const longest = Math.max(...plays.map(play => play.length))
  if (longest === 0) return []
  let valid = plays.filter(play => play.length === longest)
  if (dice.length === 2 && dice[0] !== dice[1] && longest === 1 && valid.some(play => play[0].die === Math.max(...dice))) {
    valid = valid.filter(play => play[0].die === Math.max(...dice))
  }
  return valid
}

export function firstMoves(sequences: Move[][]): Move[] {
  const unique = new Map<string, Move>()
  for (const sequence of sequences) {
    const move = sequence[0]
    if (move) unique.set(`${move.from}:${move.to}:${move.die}`, move)
  }
  return [...unique.values()]
}

export function resultKind(board: Board, winner: Player): ResultKind {
  const loser = opponent(winner)
  if (board.off[loser] > 0) return 'single'
  if (board.bar[loser] > 0 || board.points.some((count, index) => owns(count, loser) && isHome(index, winner))) return 'backgammon'
  return 'gammon'
}

export function resultPoints(kind: ResultKind, cubeValue: number): number {
  return cubeValue * (kind === 'single' ? 1 : kind === 'gammon' ? 2 : 3)
}
