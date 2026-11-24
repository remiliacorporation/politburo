import { BoardError, board, type Board } from '@vercel/board'

function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Refuse when the board is paused. The board is the one passed in, or the configured board when none is passed. No board, or a board without network pause, is not a stop. */
export async function stopIfPaused(opened?: Board): Promise<number | null> {
  if (!opened && !process.env.BOARD_URL?.trim() && !process.env.BOARD_NAME?.trim()) return null
  let status: { paused: boolean; reason?: string }
  try {
    status = await (opened ?? board()).status()
  } catch (error) {
    if (error instanceof BoardError && error.code === 'no_network_pause') return null
    throw error
  }
  if (!status.paused) return null
  const reason = typeof status.reason === 'string' ? status.reason : ''
  console.error(`error: board paused: ${safe(reason)}`)
  return 1
}
