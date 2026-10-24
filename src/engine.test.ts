import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMove, canBearOff, initialBoard, legalSequences, movesForDie, resultKind, resultPoints } from './engine.ts'
import type { Board } from './engine.ts'

const emptyBoard = (): Board => ({ points: Array(24).fill(0), bar: { light: 0, dark: 0 }, off: { light: 0, dark: 0 } })

test('initial position contains 15 checkers on each side', () => {
  const board = initialBoard()
  assert.equal(board.points.filter(count => count > 0).reduce((sum, count) => sum + count, 0), 15)
  assert.equal(board.points.filter(count => count < 0).reduce((sum, count) => sum - count, 0), 15)
  assert.equal(board.points[23], 2)
  assert.equal(board.points[0], -2)
})

test('a hit sends the opposing blot to the bar, which must be entered first', () => {
  const board = emptyBoard()
  board.points[8] = 1
  board.points[5] = -1
  const next = applyMove(board, 'light', { from: 8, to: 5, die: 3 })
  assert.equal(next.points[5], 1)
  assert.equal(next.bar.dark, 1)
  assert.deepEqual(movesForDie(next, 'dark', 2).map(move => move.from), ['bar'])
})

test('closed entry points prevent moving checkers from the bar', () => {
  const board = emptyBoard()
  board.bar.light = 1
  board.points[23] = -2
  board.points[22] = -2
  board.points[5] = 14
  assert.deepEqual(legalSequences(board, 'light', [1, 2]), [])
})

test('a higher die is mandatory when only one can be played', () => {
  const board = emptyBoard()
  board.points[0] = 1
  board.off.light = 14
  const plays = legalSequences(board, 'light', [1, 2])
  assert.ok(plays.length > 0)
  assert.ok(plays.every(play => play.length === 1 && play[0].die === 2))
})

test('the engine uses two dice when the second move is only possible after the first', () => {
  const board = emptyBoard()
  board.points[2] = 1
  board.points[1] = -2
  board.off.light = 14
  const plays = legalSequences(board, 'light', [1, 2])
  assert.ok(plays.length > 0)
  assert.ok(plays.every(play => play.length === 2 && play[0].die === 2 && play[1].die === 1))
})

test('all available dice must be played, including partial doubles', () => {
  const board = emptyBoard()
  board.bar.light = 1
  board.off.light = 14
  board.points[23] = -2
  board.points[22] = -2
  board.points[18] = -2
  const plays = legalSequences(board, 'light', [3, 3, 3, 3])
  assert.ok(plays.length > 0)
  assert.ok(plays.every(play => play.length === 1 && play[0].to === 21))
})

test('bearing off uses the farthest checker if a die is too large', () => {
  const board = emptyBoard()
  board.points[4] = 1
  board.points[2] = 1
  board.off.light = 13
  assert.equal(canBearOff(board, 'light'), true)
  assert.deepEqual(movesForDie(board, 'light', 6).filter(move => move.to === 'off').map(move => move.from), [4])
  board.bar.light = 1
  assert.equal(canBearOff(board, 'light'), false)
})

test('dark checkers enter and bear off in the opposite direction', () => {
  const board = emptyBoard()
  board.bar.dark = 1
  board.off.dark = 14
  assert.deepEqual(movesForDie(board, 'dark', 4), [{ from: 'bar', to: 3, die: 4 }])
  board.bar.dark = 0
  board.points[23] = -1
  assert.deepEqual(movesForDie(board, 'dark', 1).filter(move => move.to === 'off'), [{ from: 23, to: 'off', die: 1 }])
})

test('single, gammon and backgammon score against the cube', () => {
  const board = emptyBoard()
  board.off.light = 15
  board.off.dark = 1
  assert.equal(resultKind(board, 'light'), 'single')
  board.off.dark = 0
  board.points[15] = -15
  assert.equal(resultKind(board, 'light'), 'gammon')
  board.points[15] = 0
  board.bar.dark = 1
  assert.equal(resultKind(board, 'light'), 'backgammon')
  assert.equal(resultPoints('backgammon', 4), 12)
})
