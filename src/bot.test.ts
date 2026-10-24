import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseBotPlay, shouldAcceptDouble, shouldOfferDouble } from './bot.ts'
import { applyMove, initialBoard, legalSequences, opponent, sameMove } from './engine.ts'
import type { Board, Player } from './engine.ts'

function assertLegal(board: Board, player: Player, dice: number[]): Board {
  const chosen = chooseBotPlay(board, player, dice)
  const legal = legalSequences(board, player, dice)
  assert.ok(legal.some(sequence => sequence.length === chosen.length && sequence.every((move, index) => sameMove(move, chosen[index]))))
  return chosen.reduce((position, move) => applyMove(position, player, move), board)
}

test('bot chooses a complete legal play for either side', () => {
  const board = initialBoard()
  assertLegal(board, 'light', [1, 5])
  assertLegal(board, 'dark', [3, 4])
})

test('bot bears off the final checker when it can win immediately', () => {
  const board: Board = { points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 14, dark: 0 } }
  board.points[0] = 1
  board.points[18] = -15
  assert.equal(assertLegal(board, 'light', [1, 2]).off.light, 15)
})

test('bot handles cube decisions without a difficulty setting', () => {
  const board = initialBoard()
  assert.equal(shouldOfferDouble(board, 'light', 1), false)
  assert.equal(shouldAcceptDouble(board, 'light'), true)
  board.off.light = 14
  board.points[23] = 0
  board.points[12] = 0
  board.points[7] = 0
  board.points[5] = 1
  assert.equal(shouldAcceptDouble(board, 'dark'), false)
})

test('bot versus bot completes a deterministic game without losing checkers', () => {
  let board = initialBoard()
  let player: Player = 'light'
  let seed = 42
  const die = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % 6 + 1 }
  let turns = 0
  while (board.off.light < 15 && board.off.dark < 15 && turns < 500) {
    const first = die()
    const second = die()
    const dice = first === second ? [first, first, first, first] : [first, second]
    const play = chooseBotPlay(board, player, dice)
    board = play.reduce((position, move) => applyMove(position, player, move), board)
    const light = board.off.light + board.bar.light + board.points.filter(value => value > 0).reduce((sum, value) => sum + value, 0)
    const dark = board.off.dark + board.bar.dark - board.points.filter(value => value < 0).reduce((sum, value) => sum + value, 0)
    assert.equal(light, 15)
    assert.equal(dark, 15)
    player = opponent(player)
    turns++
  }
  assert.ok(board.off.light === 15 || board.off.dark === 15, `game stalled after ${turns} turns`)
})
