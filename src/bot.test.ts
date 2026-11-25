import assert from 'node:assert/strict'
import test from 'node:test'
import { BOT_DIFFICULTIES, chooseBotPlay, evaluateBoard, isBotDifficulty, isContact, shouldAcceptDouble, shouldOfferDouble } from './bot.ts'
import { applyMove, initialBoard, legalSequences, opponent, sameMove } from './engine.ts'
import type { Board, Player } from './engine.ts'

function assertLegal(board: Board, player: Player, dice: number[], difficulty: 'easy' | 'medium' | 'hard' = 'medium'): Board {
  const chosen = chooseBotPlay(board, player, dice, difficulty)
  const legal = legalSequences(board, player, dice)
  assert.ok(legal.some(sequence => sequence.length === chosen.length && sequence.every((move, index) => sameMove(move, chosen[index]))))
  return chosen.reduce((position, move) => applyMove(position, player, move), board)
}

test('bot chooses a complete legal play for either side across all difficulties', () => {
  const board = initialBoard()
  for (const difficulty of BOT_DIFFICULTIES) {
    assertLegal(board, 'light', [1, 5], difficulty)
    assertLegal(board, 'dark', [3, 4], difficulty)
  }
  assert.equal(isBotDifficulty('hard'), true)
  assert.equal(isBotDifficulty('unknown'), false)
})

test('bot bears off the final checker when it can win immediately', () => {
  const board: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 14, dark: 0 } }
  board.points[0] = 1
  board.points[18] = -15
  for (const difficulty of BOT_DIFFICULTIES) {
    assert.equal(assertLegal(board, 'light', [1, 2], difficulty).off.light, 15)
  }
})

test('isContact separates contact battles from pure races without blot penalties', () => {
  assert.equal(isContact(initialBoard()), true)

  const barBoard: Board = { points: Array(24).fill(0), bar: { light: 1, dark: 0 }, off: { light: 14, dark: 15 } }
  assert.equal(isContact(barBoard), true)

  const overlap: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 14, dark: 14 } }
  overlap.points[10] = 1
  overlap.points[8] = -1
  assert.equal(isContact(overlap), true)

  const raceSingle: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 13, dark: 13 } }
  raceSingle.points[3] = 1
  raceSingle.points[4] = 1
  raceSingle.points[18] = -2
  assert.equal(isContact(raceSingle), false)

  const raceStacked: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 13, dark: 13 } }
  raceStacked.points[4] = 2
  raceStacked.points[18] = -2
  assert.equal(isContact(raceStacked), false)
  assert.ok(evaluateBoard(raceSingle, 'light') > evaluateBoard(raceStacked, 'light'))
})

test('bot handles cube decisions including Crawford, dead cube and match score', () => {
  const start = initialBoard()
  assert.equal(shouldOfferDouble(start, 'light', 1), false)
  assert.equal(shouldAcceptDouble(start, 'light'), true)

  const edgeOffer: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 12, dark: 10 } }
  edgeOffer.points[0] = 3
  edgeOffer.points[20] = -5
  assert.equal(shouldOfferDouble(edgeOffer, 'light', 1), false)
  assert.equal(shouldOfferDouble(edgeOffer, 'light', 1, { targetPoints: 12, score: { light: 2, dark: 10 }, crawford: 'used' }), true)
  assert.equal(shouldOfferDouble(edgeOffer, 'light', 1, { targetPoints: 5, score: { light: 4, dark: 0 }, crawford: 'active' }), false)
  assert.equal(shouldOfferDouble(edgeOffer, 'light', 1, { targetPoints: 5, score: { light: 4, dark: 0 }, crawford: 'used' }), false)

  const edgeTake: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 12, dark: 9 } }
  edgeTake.points[0] = 3
  edgeTake.points[20] = -6
  assert.equal(shouldAcceptDouble(edgeTake, 'dark'), false)
  assert.equal(shouldAcceptDouble(edgeTake, 'dark', { targetPoints: 12, score: { light: 10, dark: 2 } }), true)
})

test('bot versus bot completes a deterministic game across difficulties without losing checkers', () => {
  for (const difficulty of BOT_DIFFICULTIES) {
    let board = initialBoard()
    let player: Player = 'light'
    let seed = 42
    const die = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % 6 + 1 }
    let turns = 0
    while (board.off.light < 15 && board.off.dark < 15 && turns < 500) {
      const first = die()
      const second = die()
      const dice = first === second ? [first, first, first, first] : [first, second]
      const play = chooseBotPlay(board, player, dice, difficulty)
      board = play.reduce((position, move) => applyMove(position, player, move), board)
      const light = board.off.light + board.bar.light + board.points.filter(value => value > 0).reduce((sum, value) => sum + value, 0)
      const dark = board.off.dark + board.bar.dark - board.points.filter(value => value < 0).reduce((sum, value) => sum + value, 0)
      assert.equal(light, 15)
      assert.equal(dark, 15)
      player = opponent(player)
      turns++
    }
    assert.ok(board.off.light === 15 || board.off.dark === 15, `game (${difficulty}) stalled after ${turns} turns`)
  }
})
