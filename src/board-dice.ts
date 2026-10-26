const pipPositions: Record<number, number[]> = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }

export function pipHtml(value: number): string {
  return Array.from({ length: 9 }, (_, index) => `<span class="board-pip ${pipPositions[value]?.includes(index) ? 'active' : ''}"></span>`).join('')
}
