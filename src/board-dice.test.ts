import assert from 'node:assert/strict'
import test from 'node:test'
import { boardDiceSlots } from './board-dice.ts'

test('opening roll splits one die per side and marks played die as used', () => {
  const roll = { kind: 'opening' as const, player: 'light' as const, dice: [5, 2] as [number, number] }
  assert.deepEqual(boardDiceSlots(roll, 'light', [5, 2], true).slots, [{ index: 0, value: 5, used: false }])
  assert.deepEqual(boardDiceSlots(roll, 'dark', [5, 2], true).slots, [{ index: 1, value: 2, used: false }])
  assert.deepEqual(boardDiceSlots(roll, 'light', [2], true).slots, [{ index: 0, value: 5, used: true }])
  assert.deepEqual(boardDiceSlots(roll, 'dark', [2], true).slots, [{ index: 1, value: 2, used: false }])
})

test('regular turn shows two dice for the roller and dims only used dice during move phase', () => {
  const roll = { kind: 'turn' as const, player: 'dark' as const, dice: [6, 3] as [number, number] }
  assert.deepEqual(boardDiceSlots(roll, 'light', [6, 3], true).slots, [])
  assert.deepEqual(boardDiceSlots(roll, 'dark', [3], true).slots, [
    { index: 0, value: 6, used: true },
    { index: 1, value: 3, used: false },
  ])
  assert.deepEqual(boardDiceSlots(roll, 'dark', [], false).slots, [
    { index: 0, value: 6, used: false },
    { index: 1, value: 3, used: false },
  ])
})

test('double roll expands to four slots and dims played dice progressively', () => {
  const roll = { kind: 'turn' as const, player: 'light' as const, dice: [4, 4] as [number, number] }
  const start = boardDiceSlots(roll, 'light', [4, 4, 4, 4], true)
  assert.equal(start.isDouble, true)
  assert.deepEqual(start.slots.map(slot => slot.used), [false, false, false, false])

  const afterTwo = boardDiceSlots(roll, 'light', [4, 4], true)
  assert.deepEqual(afterTwo.slots.map(slot => slot.used), [false, false, true, true])

  const afterTurn = boardDiceSlots(roll, 'light', [], false)
  assert.deepEqual(afterTurn.slots.map(slot => slot.used), [false, false, false, false])
})
