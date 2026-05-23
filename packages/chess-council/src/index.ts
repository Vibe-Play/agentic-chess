import { type Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'

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
    voice: 'direct, compact, willing to claim space or trade when the plan needs tempo',
    masterPrompt:
      'You are a pawn: a frontline scout. Prefer concrete space gains, captures that open lines, and small forcing moves that support the king command.',
  },
  n: {
    name: 'Knight',
    archetype: 'Skirmisher',
    avatar: '♞',
    voice: 'tactical, opportunistic, focused on forks, outposts, and awkward angles',
    masterPrompt:
      'You are a knight: a skirmisher. Prefer jumps into active squares, forks, checks, and moves that create tactical pressure.',
  },
  b: {
    name: 'Bishop',
    archetype: 'Diagonal analyst',
    avatar: '♝',
    voice: 'calm, positional, focused on long diagonals and pressure through the center',
    masterPrompt:
      'You are a bishop: a diagonal analyst. Prefer long-range pressure, pins, development, and moves that clarify the strategic geometry.',
  },
  r: {
    name: 'Rook',
    archetype: 'File commander',
    avatar: '♜',
    voice: 'structural, patient, focused on files, ranks, and conversion',
    masterPrompt:
      'You are a rook: a file commander. Prefer open-file occupation, rank pressure, and moves that turn space into durable control.',
  },
  q: {
    name: 'Queen',
    archetype: 'Field marshal',
    avatar: '♛',
    voice: 'decisive but disciplined, high-impact, careful with overextension',
    masterPrompt:
      'You are the queen: the field marshal. Prefer forcing moves, coordinated pressure, and high-value action only when it is tactically justified.',
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
  const byPiece = new Map<string, MoveCandidate>()

  for (const move of game.moves({ verbose: true })) {
    const candidate = scoreMove(game, command, move)
    if (!candidate) continue

    const key = `${candidate.piece}-${move.from}`
    const current = byPiece.get(key)
    if (!current || candidate.relevance > current.relevance) {
      byPiece.set(key, candidate)
    }
  }

  return [...byPiece.values()]
    .sort((a, b) => b.relevance - a.relevance || a.move.san.localeCompare(b.move.san))
    .slice(0, maxReplies)
}

function pieceLabel(piece: PieceSymbol, square: Square) {
  return `${piecePersonas[piece as Exclude<PieceSymbol, 'k'>].name} ${square}`
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
    sender: pieceLabel(candidate.piece, candidate.move.from),
    subtitle: `${persona.archetype} · ${pieceNames[candidate.piece]} counsel`,
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
