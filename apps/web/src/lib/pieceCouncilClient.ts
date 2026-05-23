import { type Chess } from 'chess.js'
import { orchestratePieceCouncil, type PieceReply } from '@agentic-chess/chess-council'

export type PieceCouncilResult = {
  replies: PieceReply[]
  source: 'fallback' | 'gemini'
  terminal?: string
  warning?: string
}

export async function requestPieceCouncil(
  game: Chess,
  command: string,
  maxReplies = 3,
): Promise<PieceCouncilResult> {
  const fallback = orchestratePieceCouncil(game, command, maxReplies)

  try {
    const response = await fetch('/api/piece-council', {
      body: JSON.stringify({
        command,
        fen: game.fen(),
        maxReplies,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!response.ok) {
      return {
        replies: fallback,
        source: 'fallback',
        warning: `Council server returned ${response.status}.`,
      }
    }

    const data = (await response.json()) as PieceCouncilResult
    if (data.terminal) return { replies: [], source: data.source ?? 'fallback', terminal: data.terminal }
    if (!Array.isArray(data.replies) || data.replies.length === 0) {
      return {
        replies: fallback,
        source: 'fallback',
        warning: data.warning ?? 'Council server returned no piece replies.',
      }
    }

    return {
      replies: data.replies,
      source: data.source === 'gemini' ? 'gemini' : 'fallback',
      warning: data.warning,
    }
  } catch {
    return {
      replies: fallback,
      source: 'fallback',
      warning: 'Council server is unavailable.',
    }
  }
}
