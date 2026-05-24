import { type Chess } from 'chess.js'
import { orchestratePieceCouncil, type PieceReply } from '@agentic-chess/chess-council'

export type PieceCouncilResult = {
  question?: string
  questionOptions?: string[]
  replies: PieceReply[]
  source: 'fallback' | 'gemini'
  terminal?: string
  trace?: PieceCouncilTraceEvent[]
  warning?: string
}

export type PieceCouncilTraceEvent = {
  actor: string
  content: string
  status?: 'blocked' | 'done' | 'pending'
}

export async function requestPieceCouncil(
  game: Chess,
  command: string,
  maxReplies = 3,
  promptOverrides: Partial<Record<string, string>> = {},
): Promise<PieceCouncilResult> {
  const fallback = orchestratePieceCouncil(game, command, maxReplies)

  try {
    const response = await fetch('/api/piece-council', {
      body: JSON.stringify({
        command,
        fen: game.fen(),
        maxReplies,
        promptOverrides,
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
        trace: [
          {
            actor: 'Council server',
            content: `Request failed with HTTP ${response.status}; local legal candidates were used.`,
            status: 'blocked',
          },
        ],
        warning: `Council server returned ${response.status}.`,
      }
    }

    const data = (await response.json()) as PieceCouncilResult
    if (data.question) {
      return {
        question: data.question,
        questionOptions: data.questionOptions,
        replies: [],
        source: data.source === 'gemini' ? 'gemini' : 'fallback',
        trace: data.trace,
        warning: data.warning,
      }
    }

    if (data.terminal) {
      return {
        replies: [],
        source: data.source ?? 'fallback',
        terminal: data.terminal,
        trace: data.trace,
      }
    }
    if (!Array.isArray(data.replies) || data.replies.length === 0) {
      return {
        replies: fallback,
        source: 'fallback',
        trace: data.trace,
        warning: data.warning ?? 'Council server returned no piece replies.',
      }
    }

    return {
      replies: data.replies,
      source: data.source === 'gemini' ? 'gemini' : 'fallback',
      trace: data.trace,
      warning: data.warning,
    }
  } catch {
    return {
      replies: fallback,
      source: 'fallback',
      trace: [
        {
          actor: 'Council server',
          content: 'Server is unavailable; local legal candidates were used.',
          status: 'blocked',
        },
      ],
      warning: 'Council server is unavailable.',
    }
  }
}
