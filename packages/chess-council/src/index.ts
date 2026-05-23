import { type Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import {
  bishopPrompt,
  councilPrompt,
  knightPrompt,
  pawnPrompt,
  queenPrompt,
  rookPrompt,
} from './prompts.generated.js'

export { bishopPrompt, councilPrompt, knightPrompt, pawnPrompt, queenPrompt, rookPrompt }

export type CouncilColor = 'White' | 'Black'

const personaPrompts: Record<Exclude<PieceSymbol, 'k'>, string> = {
  p: pawnPrompt,
  n: knightPrompt,
  b: bishopPrompt,
  r: rookPrompt,
  q: queenPrompt,
}

export function buildSystemPrompt(piece: Exclude<PieceSymbol, 'k'>, color: CouncilColor): string {
  const preamble = councilPrompt.replace(/\{\{COLOR\}\}/g, color)
  return `${preamble}\n\n---\n\n${personaPrompts[piece]}`
}

export type PieceReply = {
  archetype: string
  avatar: string
  content: string
  from: Square
  move: Move
  piece: PieceSymbol
  relevance: number
  sender: string
  subtitle: string
}

export type PieceCouncilContext = {
  command: string
  fen: string
  replies: PieceReply[]
  sideToMove: 'White' | 'Black'
  terminal?: string
}

type MoveCandidate = {
  features: string[]
  move: Move
  piece: PieceSymbol
  relevance: number
}

export type Persona = {
  archetype: string
  avatar: string
  masterPrompt: string
  name: string
  voice: string
}

export const piecePersonas: Record<Exclude<PieceSymbol, 'k'>, Persona> = {
  p: {
    name: 'Pawn',
    archetype: 'Frontline scout',
    avatar: '♟',
    voice: 'plural, blunt, fatalistic — speaks for the chain of pawns',
    masterPrompt: pawnPrompt,
  },
  n: {
    name: 'Knight',
    archetype: 'Skirmisher',
    avatar: '♞',
    voice: 'punchy, tactical, mischievous',
    masterPrompt: knightPrompt,
  },
  b: {
    name: 'Bishop',
    archetype: 'Diagonal analyst',
    avatar: '♝',
    voice: 'principled, slightly contrarian, speaks in diagonals and color',
    masterPrompt: bishopPrompt,
  },
  r: {
    name: 'Rook',
    archetype: 'File commander',
    avatar: '♜',
    voice: 'patient, structural, long-term',
    masterPrompt: rookPrompt,
  },
  q: {
    name: 'Queen',
    archetype: 'Field marshal',
    avatar: '♛',
    voice: 'decisive, ambitious, slightly imperious',
    masterPrompt: queenPrompt,
  },
}

const pieceNames: Record<PieceSymbol, string> = {
  b: 'bishop',
  k: 'king',
  n: 'knight',
  p: 'pawn',
  q: 'queen',
  r: 'rook',
}

const centerSquares = new Set(['d4', 'e4', 'd5', 'e5'])
const nearCenterSquares = new Set(['c3', 'd3', 'e3', 'f3', 'c4', 'f4', 'c5', 'f5', 'c6', 'd6', 'e6', 'f6'])

function rankOf(square: Square) {
  return Number(square[1])
}

function fileOf(square: Square) {
  return square.charCodeAt(0) - 96
}

function includesAny(command: string, words: string[]) {
  return words.some((word) => command.includes(word))
}

function requestedPieceBonus(command: string, piece: PieceSymbol) {
  const name = pieceNames[piece]
  if (!command.includes(name)) return 0
  return 24
}

function requestedDestinationBonus(command: string, move: Move) {
  if (command.includes(move.to)) return 28
  if (command.includes(`${move.to[0]} file`) || command.includes(`file ${move.to[0]}`)) return 8
  if (command.includes(`rank ${move.to[1]}`)) return 8
  return 0
}

function forwardDelta(color: Color, move: Move) {
  return color === 'w' ? rankOf(move.to) - rankOf(move.from) : rankOf(move.from) - rankOf(move.to)
}

function sideBonus(command: string, move: Move) {
  const file = fileOf(move.to)
  if (includesAny(command, ['king side', 'kingside'])) return file >= 5 ? 9 : -2
  if (includesAny(command, ['queen side', 'queenside'])) return file <= 4 ? 9 : -2
  return 0
}

function normalizeReplyLimit(maxReplies: number) {
  if (!Number.isFinite(maxReplies)) return 3
  return Math.min(3, Math.max(1, Math.round(maxReplies)))
}

function scoreMove(game: Chess, command: string, move: Move): MoveCandidate | null {
  const boardPiece = game.get(move.from)
  if (!boardPiece || boardPiece.type === 'k') return null

  let relevance = 10
  const features: string[] = []
  const piece = boardPiece.type
  const san = move.san
  const forward = forwardDelta(move.color, move)

  relevance += requestedPieceBonus(command, piece)
  relevance += requestedDestinationBonus(command, move)
  relevance += sideBonus(command, move)

  if (move.captured) {
    relevance += 11
    features.push(`wins ${pieceNames[move.captured]}`)
  }

  if (san.includes('+')) {
    relevance += 12
    features.push('gives check')
  }

  if (san.includes('#')) {
    relevance += 50
    features.push('delivers mate')
  }

  if (centerSquares.has(move.to)) {
    relevance += 9
    features.push('claims the center')
  } else if (nearCenterSquares.has(move.to)) {
    relevance += 4
    features.push('leans toward central control')
  }

  if (includesAny(command, ['attack', 'aggressive', 'pressure', 'threat', 'force', 'tactic', 'tactical', 'break'])) {
    if (move.captured) relevance += 12
    if (san.includes('+')) relevance += 10
    if (piece === 'n' || piece === 'q') relevance += 5
    if (forward > 0) relevance += 3
    features.push('fits the pressure plan')
  }

  if (includesAny(command, ['center', 'central', 'space', 'control'])) {
    if (centerSquares.has(move.to)) relevance += 14
    if (nearCenterSquares.has(move.to)) relevance += 7
    if (piece === 'p' && forward > 0) relevance += 5
  }

  if (includesAny(command, ['develop', 'activate', 'mobilize', 'setup', 'coordinate'])) {
    if ((piece === 'n' || piece === 'b') && ['1', '8'].includes(move.from[1])) relevance += 14
    if (piece === 'q') relevance -= 4
    features.push('improves piece activity')
  }

  if (includesAny(command, ['safe', 'solid', 'defend', 'protect', 'hold', 'king safety', 'stabilize'])) {
    if (!move.captured && !san.includes('+')) relevance += 5
    if (piece === 'p' || piece === 'b' || piece === 'n') relevance += 4
    features.push('keeps the structure controlled')
  }

  if (includesAny(command, ['pawn', 'space', 'push', 'advance'])) {
    if (piece === 'p') relevance += 15
    if (forward > 0) relevance += 5
  }

  if (move.promotion) {
    relevance += 35
    features.push('threatens promotion')
  }

  if (features.length === 0) {
    features.push('improves the position without forcing the whole army to commit')
  }

  return { features, move, piece, relevance }
}

function selectTopCandidates(game: Chess, command: string, maxReplies: number) {
  const bestByPieceClass = new Map<PieceSymbol, MoveCandidate>()
  const replyLimit = normalizeReplyLimit(maxReplies)

  for (const move of game.moves({ verbose: true })) {
    const candidate = scoreMove(game, command, move)
    if (!candidate) continue

    const current = bestByPieceClass.get(candidate.piece)
    const isBetter =
      !current ||
      candidate.relevance > current.relevance ||
      (candidate.relevance === current.relevance && candidate.move.san.localeCompare(current.move.san) < 0)

    if (isBetter) {
      bestByPieceClass.set(candidate.piece, candidate)
    }
  }

  return [...bestByPieceClass.values()]
    .sort((a, b) => b.relevance - a.relevance || a.move.san.localeCompare(b.move.san))
    .slice(0, replyLimit)
}

const pieceClassLabels: Record<Exclude<PieceSymbol, 'k'>, string> = {
  b: 'Bishops',
  n: 'Knights',
  p: 'Pawns',
  q: 'Queen',
  r: 'Rooks',
}

function pieceLabel(piece: PieceSymbol) {
  return pieceClassLabels[piece as Exclude<PieceSymbol, 'k'>]
}

function buildReply(candidate: MoveCandidate): PieceReply {
  const persona = piecePersonas[candidate.piece as Exclude<PieceSymbol, 'k'>]
  const featureText = candidate.features.slice(0, 2).join(' and ')

  return {
    archetype: persona.archetype,
    avatar: persona.avatar,
    content: `King, I can play ${candidate.move.san} from ${candidate.move.from} to ${candidate.move.to}. That ${featureText}.`,
    from: candidate.move.from,
    move: candidate.move,
    piece: candidate.piece,
    relevance: candidate.relevance,
    sender: pieceLabel(candidate.piece),
    subtitle: `${persona.archetype} · best ${pieceNames[candidate.piece]} move from ${candidate.move.from}`,
  }
}

export function buildPieceCouncilContext(game: Chess, command: string, maxReplies = 3): PieceCouncilContext {
  const sideToMove = game.turn() === 'w' ? 'White' : 'Black'

  if (game.isCheckmate()) {
    return {
      command,
      fen: game.fen(),
      replies: [],
      sideToMove,
      terminal: `Checkmate is on the board. ${game.turn() === 'w' ? 'Black' : 'White'} has won.`,
    }
  }

  if (game.isDraw()) {
    return {
      command,
      fen: game.fen(),
      replies: [],
      sideToMove,
      terminal: 'The current chess.js rules mark this position as drawn.',
    }
  }

  return {
    command,
    fen: game.fen(),
    replies: selectTopCandidates(game, command.toLowerCase(), maxReplies).map(buildReply),
    sideToMove,
  }
}

export function orchestratePieceCouncil(game: Chess, command: string, maxReplies = 3): PieceReply[] {
  return buildPieceCouncilContext(game, command, maxReplies).replies
}
