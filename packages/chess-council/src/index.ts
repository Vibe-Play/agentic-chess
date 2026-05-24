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
  content?: string
  features: string[]
  move: Move
  piece: PieceSymbol
  relevance: number
  sender?: string
  subtitle?: string
}

export type Persona = {
  archetype: string
  avatar: string
  masterPrompt: string
  name: string
  voice: string
}

export const piecePersonas: Record<PieceSymbol, Persona> = {
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
  k: {
    name: 'Castling',
    archetype: 'Royal guard',
    avatar: '♔',
    voice: 'calm, protective, only speaks for legal king moves and castling lanes',
    masterPrompt:
      'You are the royal guard, not the user. You only advise on legal king movement, especially castling and urgent king-safety moves.',
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

function normalizeMoveText(value: string) {
  return value
    .toLowerCase()
    .replace(/[+#?!]/g, '')
    .replace(/0/g, 'o')
    .replace(/\s+/g, '')
}

function isCastleMove(move: Move) {
  return normalizeMoveText(move.san).startsWith('o-o')
}

function hasCastleIntent(command: string) {
  return includesAny(command, [
    'castle',
    'castling',
    'o-o',
    '0-0',
    'king side',
    'kingside',
    'queen side',
    'queenside',
    'long castle',
    'short castle',
  ])
}

function hasKingMoveIntent(command: string) {
  return (
    hasCastleIntent(command) ||
    includesAny(command, ['move king', 'king move', 'king to', 'with king', 'king escape', 'king run'])
  )
}

function requestedPieceBonus(command: string, piece: PieceSymbol) {
  const name = pieceNames[piece]
  if (!command.includes(name)) return 0
  return 24
}

function requestedSanBonus(command: string, move: Move) {
  const normalizedCommand = normalizeMoveText(command)
  const normalizedSan = normalizeMoveText(move.san)

  if (normalizedCommand.includes(normalizedSan)) return 40
  if (normalizedCommand.includes(`${move.from}${move.to}`)) return 34
  if (command.includes(`${move.from}-${move.to}`) || command.includes(`${move.from} to ${move.to}`)) return 34
  return 0
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

function scoreMove(game: Chess, command: string, move: Move, options: { allowKing?: boolean } = {}): MoveCandidate | null {
  const boardPiece = game.get(move.from)
  if (!boardPiece) return null

  const castleIntent = hasCastleIntent(command)
  const kingMoveIntent = hasKingMoveIntent(command)
  const castleMove = isCastleMove(move)

  if (boardPiece.type === 'k' && !options.allowKing && !kingMoveIntent) return null
  if (boardPiece.type === 'k' && castleIntent && !castleMove) return null

  let relevance = 10
  const features: string[] = []
  const piece = boardPiece.type
  const san = move.san
  const forward = forwardDelta(move.color, move)

  relevance += requestedPieceBonus(command, piece)
  relevance += requestedSanBonus(command, move)
  relevance += requestedDestinationBonus(command, move)
  relevance += sideBonus(command, move)

  if (piece === 'k') {
    relevance += castleMove ? 92 : 30
    features.push(castleMove ? 'gets the king castled' : 'answers with a direct king move')

    if (castleMove && castleIntent) {
      relevance += 64
      if (move.to[0] === 'g') features.push('locks in the short castle')
      if (move.to[0] === 'c') features.push('locks in the long castle')
    }
  }

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

function pieceLabel(candidate: MoveCandidate) {
  if (candidate.piece === 'k') return isCastleMove(candidate.move) ? 'Castling' : 'Royal guard'
  return pieceClassLabels[candidate.piece as Exclude<PieceSymbol, 'k'>]
}

function buildReply(candidate: MoveCandidate): PieceReply {
  const persona = piecePersonas[candidate.piece]
  const featureText = candidate.features.slice(0, 2).join(' and ')

  return {
    archetype: persona.archetype,
    avatar: persona.avatar,
    content:
      candidate.content ??
      `King, I can play ${candidate.move.san} from ${candidate.move.from} to ${candidate.move.to}. That ${featureText}.`,
    from: candidate.move.from,
    move: candidate.move,
    piece: candidate.piece,
    relevance: candidate.relevance,
    sender: candidate.sender ?? pieceLabel(candidate),
    subtitle: candidate.subtitle ?? `${persona.archetype} · best ${pieceNames[candidate.piece]} move from ${candidate.move.from}`,
  }
}

function getTerminalContext(game: Chess, command: string): PieceCouncilContext | null {
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

  return null
}

function findLegalMove(game: Chess, selection: ManagedMoveSelection) {
  const from = typeof selection.from === 'string' ? selection.from : ''
  const to = typeof selection.to === 'string' ? selection.to : ''
  const san = typeof selection.san === 'string' ? normalizeMoveText(selection.san) : ''

  return game.moves({ verbose: true }).find((move) => {
    if (from && move.from !== from) return false
    if (to && move.to !== to) return false
    if (san && normalizeMoveText(move.san) !== san) return false
    return Boolean(from || to || san)
  })
}

function finiteRelevance(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export type ManagedMoveSelection = {
  content?: string
  from?: string
  relevance?: number
  san?: string
  sender?: string
  subtitle?: string
  to?: string
}

export function buildManagedPieceCouncilContext(
  game: Chess,
  command: string,
  selections: ManagedMoveSelection[],
  maxReplies = 3,
): PieceCouncilContext {
  const terminal = getTerminalContext(game, command)
  if (terminal) return terminal

  const sideToMove = game.turn() === 'w' ? 'White' : 'Black'
  const commandLower = command.toLowerCase()
  const replyLimit = normalizeReplyLimit(maxReplies)
  const bestByPieceClass = new Map<PieceSymbol, MoveCandidate>()

  selections.forEach((selection, index) => {
    const move = findLegalMove(game, selection)
    if (!move) return

    const scored = scoreMove(game, commandLower, move, { allowKing: true })
    const boardPiece = game.get(move.from)
    if (!boardPiece) return

    const candidate: MoveCandidate =
      scored ??
      ({
        features: ['is the director-selected legal move'],
        move,
        piece: boardPiece.type,
        relevance: 10,
      } satisfies MoveCandidate)

    const managedCandidate: MoveCandidate = {
      ...candidate,
      content: selection.content?.trim() || candidate.content,
      relevance: candidate.relevance + 180 - index * 8 + finiteRelevance(selection.relevance),
      sender: selection.sender?.trim() || candidate.sender,
      subtitle: selection.subtitle?.trim() || candidate.subtitle,
    }

    const current = bestByPieceClass.get(managedCandidate.piece)
    if (!current || managedCandidate.relevance > current.relevance) {
      bestByPieceClass.set(managedCandidate.piece, managedCandidate)
    }
  })

  return {
    command,
    fen: game.fen(),
    replies: [...bestByPieceClass.values()]
      .sort((a, b) => b.relevance - a.relevance || a.move.san.localeCompare(b.move.san))
      .slice(0, replyLimit)
      .map(buildReply),
    sideToMove,
  }
}

export function buildPieceCouncilContext(game: Chess, command: string, maxReplies = 3): PieceCouncilContext {
  const terminal = getTerminalContext(game, command)
  if (terminal) return terminal
  const sideToMove = game.turn() === 'w' ? 'White' : 'Black'

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
