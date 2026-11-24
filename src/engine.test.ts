import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMove, canBearOff, initialBoard, legalSequences, movesForDie, pipCount, resultKind, resultPoints, sameMove } from './engine.ts'
import type { Board, Move } from './engine.ts'

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

test('immediate winning bear-off is allowed even when a two-step play exists', () => {
  const hasSequence = (plays: Move[][], expected: Move[]) =>
    plays.some(play => play.length === expected.length && play.every((move, index) => sameMove(move, expected[index])))

  const lightBoard = emptyBoard()
  lightBoard.points[2] = 1
  lightBoard.off.light = 14
  const lightPlays = legalSequences(lightBoard, 'light', [2, 5])
  assert.ok(hasSequence(lightPlays, [{ from: 2, to: 'off', die: 5 }]))
  assert.ok(hasSequence(lightPlays, [{ from: 2, to: 0, die: 2 }, { from: 0, to: 'off', die: 5 }]))

  const darkBoard = emptyBoard()
  darkBoard.points[21] = -1
  darkBoard.off.dark = 14
  const darkPlays = legalSequences(darkBoard, 'dark', [2, 5])
  assert.ok(hasSequence(darkPlays, [{ from: 21, to: 'off', die: 5 }]))
  assert.ok(hasSequence(darkPlays, [{ from: 21, to: 23, die: 2 }, { from: 23, to: 'off', die: 5 }]))
})

test('pipCount matches standard initial count, bar penalty and borne-off checkers', () => {
  const start = initialBoard()
  assert.equal(pipCount(start, 'light'), 167)
  assert.equal(pipCount(start, 'dark'), 167)

  const board = emptyBoard()
  board.bar.light = 1
  board.points[5] = 2
  board.off.light = 12
  board.bar.dark = 2
  board.points[18] = -1
  board.off.dark = 12
  assert.equal(pipCount(board, 'light'), 25 + 2 * 6)
  assert.equal(pipCount(board, 'dark'), 50 + 6)
})
