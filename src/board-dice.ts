import type { Player } from './engine.ts'

export interface BoardRoll {
  kind: 'opening' | 'turn'
  player: Player
  dice: [number, number]
}

export interface DiceSlot {
  index: number
  value: number
  used: boolean
}

export interface DiceAnimator {
  isRolling: () => boolean
  valueFor: (index: number, actual: number) => number
  start: (onDone: () => void) => boolean
  stop: () => void
}

const pipPositions: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

export function pipHtml(value: number): string {
  return Array.from({ length: 9 }, (_, index) => `<span class="board-pip ${pipPositions[value]?.includes(index) ? 'active' : ''}"></span>`).join('')
}

export function boardDiceSlots(
  roll: BoardRoll | null,
  side: Player,
  remaining: number[],
  inMovePhase: boolean,
): { slots: DiceSlot[]; isDouble: boolean } {
  if (!roll || roll.dice.length < 2) return { slots: [], isDouble: false }
  if (roll.kind === 'opening') {
    const index = side === 'light' ? 0 : 1
    const value = roll.dice[index]
    return {
      slots: [{ index, value, used: inMovePhase && !remaining.includes(value) }],
      isDouble: false,
    }
  }
  if (roll.player !== side) return { slots: [], isDouble: false }
  const [first, second] = roll.dice
  if (first === second) {
    const leftCount = inMovePhase ? remaining.filter(die => die === first).length : 4
    const activeCount = Math.max(0, Math.min(4, leftCount))
    return {
      slots: Array.from({ length: 4 }, (_, index) => ({
        index,
        value: first,
        used: inMovePhase && index >= activeCount,
      })),
      isDouble: true,
    }
  }
  return {
    slots: [
      { index: 0, value: first, used: inMovePhase && !remaining.includes(first) },
      { index: 1, value: second, used: inMovePhase && !remaining.includes(second) },
    ],
    isDouble: false,
  }
}

const randomVisualDie = () => Math.floor(Math.random() * 6) + 1

export function createDiceAnimator(container: HTMLElement, durationMs = 1050, tickMs = 75): DiceAnimator {
  let rolling = false
  let faces: [number, number, number, number] = [1, 1, 1, 1]
  let tickTimer: number | undefined
  let endTimer: number | undefined

  const scramble = () => {
    faces = [randomVisualDie(), randomVisualDie(), randomVisualDie(), randomVisualDie()]
  }

  const stop = () => {
    if (tickTimer !== undefined) window.clearInterval(tickTimer)
    if (endTimer !== undefined) window.clearTimeout(endTimer)
    tickTimer = undefined
    endTimer = undefined
    rolling = false
  }

  const start = (onDone: () => void): boolean => {
    stop()
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    rolling = true
    scramble()
    tickTimer = window.setInterval(() => {
      scramble()
      container.querySelectorAll<HTMLElement>('[data-board-die]').forEach(element => {
        const index = Number(element.dataset.boardDie)
        element.innerHTML = pipHtml(faces[index] ?? faces[0])
      })
    }, tickMs)
    endTimer = window.setTimeout(() => {
      stop()
      onDone()
    }, durationMs)
    return true
  }

  return {
    isRolling: () => rolling,
    valueFor: (index: number, actual: number) => rolling ? (faces[index] ?? faces[0]) : actual,
    start,
    stop,
  }
}
