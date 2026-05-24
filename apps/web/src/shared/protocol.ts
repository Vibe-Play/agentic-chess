import type { Move } from 'chess.js'

export type PlayerColor = 'white' | 'black'

export type GameStatus =
  | { kind: 'waiting' }
  | { kind: 'in_progress'; inCheck: boolean }
  | { kind: 'checkmate'; winner: PlayerColor }
  | { kind: 'stalemate' }
  | { kind: 'draw' }

export type ClientGameState = {
  id: string
  fen: string
  pgn: string
  turn: PlayerColor
  history: Move[]
  status: GameStatus
  hostConnected: boolean
  guestConnected: boolean
  lastMove: { from: string; san: string; to: string } | null
}
