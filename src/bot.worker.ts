import { chooseBotPlay } from './bot.ts'
import type { BotDifficulty } from './bot.ts'
import type { Board, Player } from './engine.ts'

interface Request { id: number; board: Board; player: Player; dice: number[]; difficulty?: BotDifficulty }

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { id, board, player, dice, difficulty } = event.data
  try {
    self.postMessage({ id, play: chooseBotPlay(board, player, dice, difficulty) })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Ошибка расчёта хода' })
  }
})
