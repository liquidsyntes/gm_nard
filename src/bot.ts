import { applyMove, legalSequences, opponent } from './engine.ts'
import type { Board, Move, Player } from './engine.ts'

const diceRolls = Array.from({ length: 6 }, (_, a) =>
  Array.from({ length: 6 - a }, (_, offset) => {
    const b = a + offset
    return { dice: a === b ? [a + 1, a + 1, a + 1, a + 1] : [a + 1, b + 1], weight: a === b ? 1 : 2 }
  }),
).flat()

function ownerCount(board: Board, player: Player, point: number): number {
  return Math.max(0, board.points[point] * (player === 'light' ? 1 : -1))
}

function pipCount(board: Board, player: Player): number {
  let total = board.bar[player] * 25
  for (let point = 0; point < 24; point++) {
    total += ownerCount(board, player, point) * (player === 'light' ? point + 1 : 24 - point)
  }
  return total
}

function sideStructure(board: Board, player: Player): number {
  let value = 0
  let primeLength = 0
  const enemy = opponent(player)
  for (let point = 0; point < 24; point++) {
    const count = ownerCount(board, player, point)
    if (count >= 2) {
      primeLength++
      value += 3
      if ((player === 'light' && point < 6) || (player === 'dark' && point >= 18)) value += board.bar[enemy] > 0 ? 3 : 1
    } else {
      if (primeLength > 1) value += primeLength * primeLength * 1.5
      primeLength = 0
      if (count === 1) {
        let threatened = board.bar[enemy] > 0 && (player === 'light' ? point < 6 : point >= 18)
        for (let distance = 1; distance <= 6 && !threatened; distance++) {
          const attacker = point - distance * (enemy === 'light' ? -1 : 1)
          if (attacker >= 0 && attacker < 24 && ownerCount(board, enemy, attacker) > 0) threatened = true
        }
        if (threatened) value -= 6
      }
    }
  }
  if (primeLength > 1) value += primeLength * primeLength * 1.5
  return value
}

export function evaluateBoard(board: Board, player: Player): number {
  const enemy = opponent(player)
  if (board.off[player] === 15) return 100000
  if (board.off[enemy] === 15) return -100000
  return (pipCount(board, enemy) - pipCount(board, player))
    + (board.off[player] - board.off[enemy]) * 5
    + (board.bar[enemy] - board.bar[player]) * 12
    + sideStructure(board, player) - sideStructure(board, enemy)
}

export function estimatedWinChance(board: Board, player: Player): number {
  if (board.off[player] === 15) return 1
  if (board.off[opponent(player)] === 15) return 0
  const advantage = evaluateBoard(board, player)
  return Math.max(0.02, Math.min(0.98, 1 / (1 + Math.exp(-advantage / 42))))
}

export function shouldOfferDouble(board: Board, player: Player, cubeValue: number): boolean {
  const chance = estimatedWinChance(board, player)
  return cubeValue < 64 && chance >= 0.72 && chance <= 0.92
}

export function shouldAcceptDouble(board: Board, player: Player): boolean {
  return estimatedWinChance(board, player) >= 0.27
}

function afterPlay(board: Board, player: Player, play: Move[]): Board {
  return play.reduce((position, move) => applyMove(position, player, move), board)
}

function boardKey(board: Board): string {
  return `${board.points.join(',')}|${board.bar.light},${board.bar.dark}|${board.off.light},${board.off.dark}`
}

interface Candidate { play: Move[]; board: Board; value: number }

export function chooseBotPlay(board: Board, player: Player, dice: number[]): Move[] {
  const plays = legalSequences(board, player, dice)
  if (plays.length === 0) return []

  const unique = new Map<string, Candidate>()
  for (const play of plays) {
    const resultingBoard = afterPlay(board, player, play)
    const key = boardKey(resultingBoard)
    if (!unique.has(key)) unique.set(key, { play, board: resultingBoard, value: evaluateBoard(resultingBoard, player) })
  }
  const candidates = [...unique.values()].sort((a, b) => b.value - a.value)
  if (candidates[0].value === 100000 || candidates.length === 1) return candidates[0].play

  // Keep the strongest static positions, then include every possible opposing roll.
  const finalists = candidates.slice(0, 5)
  let best = finalists[0]
  let bestExpected = -Infinity
  for (const candidate of finalists) {
    let sum = 0
    for (const roll of diceRolls) {
      const replies = legalSequences(candidate.board, opponent(player), roll.dice)
      let replyValue = evaluateBoard(candidate.board, player)
      if (replies.length > 0) {
        replyValue = Infinity
        for (const reply of replies) {
          const position = afterPlay(candidate.board, opponent(player), reply)
          replyValue = Math.min(replyValue, evaluateBoard(position, player))
        }
      }
      sum += replyValue * roll.weight
    }
    const expected = sum / 36
    if (expected > bestExpected) { bestExpected = expected; best = candidate }
  }
  return best.play
}
