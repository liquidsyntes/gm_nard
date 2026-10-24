import { chooseBotPlay } from './bot.ts'
import type { Board, Player } from './engine.ts'

interface Request { id: number; board: Board; player: Player; dice: number[] }

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { id, board, player, dice } = event.data
  try {
    self.postMessage({ id, play: chooseBotPlay(board, player, dice) })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : 'Ошибка расчёта хода' })
  }
})
