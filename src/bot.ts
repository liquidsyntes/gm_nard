import { opponent, pipCount, uniqueEndPositions } from './engine.ts'
import type { Board, CrawfordState, Move, Player } from './engine.ts'

export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number]

export interface CubeContext {
  difficulty?: BotDifficulty
  targetPoints?: number | null
  score?: Record<Player, number>
  crawford?: CrawfordState
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === 'string' && (BOT_DIFFICULTIES as readonly string[]).includes(value)
}

const diceRolls = Array.from({ length: 6 }, (_, a) =>
  Array.from({ length: 6 - a }, (_, offset) => {
    const b = a + offset
    return { dice: a === b ? [a + 1, a + 1, a + 1, a + 1] : [a + 1, b + 1], weight: a === b ? 1 : 2 }
  }),
).flat()

function ownerCount(board: Board, player: Player, point: number): number {
  return Math.max(0, board.points[point] * (player === 'light' ? 1 : -1))
}

function homePointIndex(player: Player, distance: number): number {
  return player === 'light' ? distance - 1 : 24 - distance
}

export function isContact(board: Board): boolean {
  if (board.bar.light > 0 || board.bar.dark > 0) return true
  let maxLight = -1
  let minDark = 24
  for (let point = 0; point < 24; point++) {
    if (board.points[point] > 0) maxLight = point
    else if (board.points[point] < 0 && point < minDark) minDark = point
  }
  return maxLight > minDark
}

function racePenalty(board: Board, player: Player): number {
  const p1 = ownerCount(board, player, homePointIndex(player, 1))
  const p2 = ownerCount(board, player, homePointIndex(player, 2))
  let penalty = (p1 > 2 ? (p1 - 2) * 0.9 : 0) + (p2 > 3 ? (p2 - 3) * 0.5 : 0)
  let maxHomeDist = 0
  for (let d = 6; d >= 1; d--) {
    if (ownerCount(board, player, homePointIndex(player, d)) > 0) {
      maxHomeDist = d
      break
    }
  }
  for (let d = 1; d < maxHomeDist; d++) {
    if (ownerCount(board, player, homePointIndex(player, d)) === 0) penalty += 0.8
  }
  return penalty
}

function contactStructure(board: Board, player: Player): number {
  let value = 0
  let primeLength = 0
  const enemy = opponent(player)
  const enemyDir = enemy === 'light' ? -1 : 1

  for (let point = 0; point < 24; point++) {
    const count = ownerCount(board, player, point)
    const distFromOut = player === 'light' ? point + 1 : 24 - point
    const home = distFromOut <= 6

    if (count >= 2) {
      primeLength++
      value += 3
      if (home) value += board.bar[enemy] > 0 ? 3.5 : 1.5
      if (distFromOut >= 19) value += distFromOut <= 21 ? 3.2 : 1.8
      if (!home && count > 4) value -= (count - 4) * 1.2
    } else {
      if (primeLength > 1) value += primeLength * primeLength * 1.6
      primeLength = 0
      if (count === 1) {
        let directShots = board.bar[enemy] > 0 && home ? 1 : 0
        let indirectShots = 0
        for (let distance = 1; distance <= 12; distance++) {
          const attacker = point - distance * enemyDir
          if (attacker >= 0 && attacker < 24 && ownerCount(board, enemy, attacker) > 0) {
            if (distance <= 6) directShots++
            else indirectShots++
          }
        }
        const lossScale = 0.6 + (25 - distFromOut) / 24
        value -= (Math.min(directShots, 4) * 3.8 + Math.min(indirectShots, 4) * 1.1) * lossScale
      }
    }
  }
  if (primeLength > 1) value += primeLength * primeLength * 1.6
  return value
}

export function evaluateBoard(board: Board, player: Player): number {
  const enemy = opponent(player)
  if (board.off[player] === 15) return 100000
  if (board.off[enemy] === 15) return -100000

  if (!isContact(board)) {
    return (pipCount(board, enemy) - pipCount(board, player)) * 1.35
      + (board.off[player] - board.off[enemy]) * 6
      + racePenalty(board, enemy) - racePenalty(board, player)
  }

  return (pipCount(board, enemy) - pipCount(board, player)) * 0.9
    + (board.off[player] - board.off[enemy]) * 5
    + (board.bar[enemy] - board.bar[player]) * 14
    + contactStructure(board, player) - contactStructure(board, enemy)
}

export function estimatedWinChance(board: Board, player: Player): number {
  if (board.off[player] === 15) return 1
  if (board.off[opponent(player)] === 15) return 0
  const advantage = evaluateBoard(board, player)
  return Math.max(0.02, Math.min(0.98, 1 / (1 + Math.exp(-advantage / 42))))
}

function estimatedGammonChance(board: Board, player: Player): number {
  const enemy = opponent(player)
  if (board.off[enemy] > 0) return 0
  const lead = pipCount(board, enemy) - pipCount(board, player)
  if (lead <= 18) return 0
  let trapped = board.bar[enemy] * 2
  for (let point = 0; point < 24; point++) {
    const enemyInHome = enemy === 'light' ? point <= 5 : point >= 18
    if (!enemyInHome) trapped += ownerCount(board, enemy, point)
  }
  return Math.min(0.35, ((lead - 18) / 90) * (0.45 + Math.min(trapped, 6) * 0.1))
}

export function shouldOfferDouble(board: Board, player: Player, cubeValue: number, context: CubeContext = {}): boolean {
  if (context.crawford === 'active' || cubeValue >= 64) return false
  if (context.targetPoints && context.score && context.score[player] + cubeValue >= context.targetPoints) return false

  const difficulty = context.difficulty ?? 'medium'
  const chance = estimatedWinChance(board, player)
  let minOffer = difficulty === 'easy' ? 0.78 : 0.72
  const maxOffer = difficulty === 'easy' ? 0.90 : 0.92

  if (context.targetPoints && context.score) {
    const myAway = context.targetPoints - context.score[player]
    const oppAway = context.targetPoints - context.score[opponent(player)]
    if (myAway > oppAway) minOffer -= Math.min(0.07, (myAway - oppAway) * 0.015)
  }
  if (estimatedGammonChance(board, player) > 0.15) minOffer -= 0.03
  return chance >= minOffer && chance <= maxOffer
}

export function shouldAcceptDouble(board: Board, player: Player, context: CubeContext = {}): boolean {
  const difficulty = context.difficulty ?? 'medium'
  let takePoint = difficulty === 'easy' ? 0.24 : 0.27
  takePoint += estimatedGammonChance(board, opponent(player)) * 0.25
  if (context.targetPoints && context.score) {
    const myAway = context.targetPoints - context.score[player]
    const oppAway = context.targetPoints - context.score[opponent(player)]
    if (myAway > oppAway) takePoint -= 0.04
  }
  return estimatedWinChance(board, player) >= takePoint
}

function pickEasyCandidate<T extends { value: number }>(candidates: T[]): T {
  const pool = candidates.slice(0, 3).filter(candidate => candidates[0].value - candidate.value <= 14)
  if (pool.length <= 1) return candidates[0]
  const weights = [55, 30, 15].slice(0, pool.length)
  const total = weights.reduce((sum, w) => sum + w, 0)
  let roll = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return pool[i]
  }
  return pool[0]
}

export function chooseBotPlay(board: Board, player: Player, dice: number[], difficulty: BotDifficulty = 'medium'): Move[] {
  const positions = uniqueEndPositions(board, player, dice)
  if (positions.length === 0) return []

  const candidates = positions
    .map(position => ({ play: position.play, board: position.board, value: evaluateBoard(position.board, player) }))
    .sort((a, b) => b.value - a.value)

  if (candidates[0].value === 100000 || candidates.length === 1) return candidates[0].play
  if (difficulty === 'easy') return pickEasyCandidate(candidates).play

  const finalistLimit = difficulty === 'hard' ? 10 : 5
  const finalists = candidates.slice(0, finalistLimit)
  const enemy = opponent(player)
  let best = finalists[0]
  let bestExpected = -Infinity

  for (const candidate of finalists) {
    let sum = 0
    for (const roll of diceRolls) {
      const replies = uniqueEndPositions(candidate.board, enemy, roll.dice)
      let replyValue = evaluateBoard(candidate.board, player)
      if (replies.length > 0) {
        replyValue = Infinity
        for (const reply of replies) {
          replyValue = Math.min(replyValue, evaluateBoard(reply.board, player))
        }
      }
      sum += replyValue * roll.weight
    }
    const expected = sum / 36
    if (expected > bestExpected) { bestExpected = expected; best = candidate }
  }
  return best.play
}
