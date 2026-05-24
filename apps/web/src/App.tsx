import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { CornerDownLeft, LoaderCircle, X } from 'lucide-react'
import { Navigate, Route, Routes } from 'react-router-dom'
import {
  bishopPrompt,
  knightPrompt,
  pawnPrompt,
  queenPrompt,
  rookPrompt,
} from '@agentic-chess/chess-council'
import { FlatChessBoard, type PieceMoveSuggestion, type PieceReplyBubble } from './components/FlatChessBoard'
import { requestPieceCouncil, type PieceCouncilTraceEvent } from './lib/pieceCouncilClient'
import { Lobby } from './pages/Lobby'
import { MultiplayerGame } from './pages/MultiplayerGame'

type ChatMessage = {
  avatar?: string
  id: number
  role: 'king' | 'piece' | 'system'
  sender: string
  subtitle?: string
  content: string
}

type TurnThread = {
  id: string
  messages: ChatMessage[]
  subtitle: string
  title: string
}

type SavedGameSession = {
  lastMove: { from: Square; to: Square } | null
  pgn: string
}

type CouncilRoomEvent = {
  actor: string
  content: string
  id: number
  status?: PieceCouncilTraceEvent['status']
  tone?: 'king' | 'piece' | 'system'
}

type PromptClassId = Exclude<PieceSymbol, 'k'>

type PromptClassDefinition = {
  defaultPrompt: string
  icon: string
  id: PromptClassId
  name: string
  role: string
}

type PromptTextSizes = Partial<Record<PromptClassId, number>>

type KingDirectiveSuggestion = {
  label: string
  priority: number
  text: string
}

const gameSessionKey = 'agentic-chess:game-session:v1'
const promptOverridesKey = 'agentic-chess:prompt-overrides:v1'
const promptTextSizeKey = 'agentic-chess:prompt-text-size:v1'

function sideName(side: Color) {
  return side === 'w' ? 'White' : 'Black'
}

function turnNumberFromHalfMoves(halfMoves: number) {
  return Math.floor(halfMoves / 2) + 1
}

function currentThreadTitle(game: Chess) {
  return `${sideName(game.turn())} turn ${turnNumberFromHalfMoves(game.history().length)}`
}

function createTurnIntro(side: Color, halfMoves: number): ChatMessage {
  return {
    id: Date.now() + Math.random(),
    role: 'system',
    sender: 'Piece council',
    subtitle: `${sideName(side)} to move · turn ${turnNumberFromHalfMoves(halfMoves)}`,
    content: 'New turn thread started. Command your pieces as king and the top legal candidates will respond.',
  }
}

function cloneGame(game: Chess) {
  const next = new Chess()
  next.loadPgn(game.pgn())
  return next
}

function describeMove(move: Move) {
  const capture = move.captured ? ' captures' : ''
  const suffix = move.san.includes('+') ? ' with check' : move.san.includes('#') ? ' with mate' : ''
  return `${move.color === 'w' ? 'White' : 'Black'}: ${move.from}-${move.to}${capture} (${move.san})${suffix}`
}

function toSuggestion(move: Move): PieceMoveSuggestion {
  return {
    from: move.from,
    promotion: move.promotion,
    san: move.san,
    to: move.to,
  }
}

function getSessionStorage() {
  if (typeof window === 'undefined') return null

  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function getLocalStorage() {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage
  } catch {
    return null
  }
}

function loadPromptOverrides(): Partial<Record<PromptClassId, string>> {
  const storage = getLocalStorage()
  const saved = storage?.getItem(promptOverridesKey)
  if (!saved) return {}

  try {
    const parsed = JSON.parse(saved) as Partial<Record<PromptClassId, string>>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [PromptClassId, string] => {
        return ['p', 'n', 'b', 'r', 'q'].includes(entry[0]) && typeof entry[1] === 'string'
      }),
    ) as Partial<Record<PromptClassId, string>>
  } catch {
    storage?.removeItem(promptOverridesKey)
    return {}
  }
}

function clampPromptTextSize(value: number) {
  return Math.min(18, Math.max(12, value))
}

function loadPromptTextSizes(): PromptTextSizes {
  const storage = getLocalStorage()
  const saved = storage?.getItem(promptTextSizeKey)
  if (!saved) return {}

  try {
    const parsed = JSON.parse(saved) as unknown
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
      return Object.fromEntries(promptClassDefinitions.map((agent) => [agent.id, clampPromptTextSize(parsed)])) as PromptTextSizes
    }
    if (!parsed || typeof parsed !== 'object') return {}

    const entries = Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [PromptClassId, number] => {
        return ['p', 'n', 'b', 'r', 'q'].includes(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1])
      })
      .map(([key, value]) => [key, clampPromptTextSize(value)])

    return Object.fromEntries(entries) as PromptTextSizes
  } catch {
    storage?.removeItem(promptTextSizeKey)
    return {}
  }
}

function lastMoveFromGame(game: Chess): { from: Square; to: Square } | null {
  const history = game.history({ verbose: true })
  const move = history[history.length - 1]
  return move ? { from: move.from, to: move.to } : null
}

function loadSavedGameSession(): SavedGameSession {
  const fallbackGame = new Chess()
  const storage = getSessionStorage()
  const saved = storage?.getItem(gameSessionKey)

  if (!saved) {
    return {
      lastMove: null,
      pgn: fallbackGame.pgn(),
    }
  }

  try {
    const parsed = JSON.parse(saved) as Partial<SavedGameSession>
    const restored = new Chess()
    if (typeof parsed.pgn === 'string' && parsed.pgn.trim()) {
      restored.loadPgn(parsed.pgn)
    }

    return {
      lastMove: lastMoveFromGame(restored),
      pgn: restored.pgn(),
    }
  } catch {
    storage?.removeItem(gameSessionKey)
    return {
      lastMove: null,
      pgn: fallbackGame.pgn(),
    }
  }
}

function createGameFromSession(session: SavedGameSession) {
  const game = new Chess()
  if (session.pgn.trim()) {
    game.loadPgn(session.pgn)
  }
  return game
}

function isTerminalGame(game: Chess) {
  return game.isCheckmate() || game.isDraw()
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

const capturedGlyphs: Record<PieceSymbol, string> = {
  p: '♟',
  n: '♞',
  b: '♝',
  r: '♜',
  q: '♛',
  k: '♚',
}

const pieceValues: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
const pieceClassRoomLabels: Record<Exclude<PieceSymbol, 'k'>, string> = {
  b: 'Bishops',
  n: 'Knights',
  p: 'Pawns',
  q: 'Queen',
  r: 'Rooks',
}
const centralSquares = new Set(['c4', 'd4', 'e4', 'f4', 'c5', 'd5', 'e5', 'f5'])

const promptClassDefinitions: PromptClassDefinition[] = [
  {
    defaultPrompt: pawnPrompt,
    icon: '♙',
    id: 'p',
    name: 'Pawns',
    role: 'Frontline scout',
  },
  {
    defaultPrompt: knightPrompt,
    icon: '♘',
    id: 'n',
    name: 'Knights',
    role: 'Skirmisher',
  },
  {
    defaultPrompt: bishopPrompt,
    icon: '♗',
    id: 'b',
    name: 'Bishops',
    role: 'Diagonal analyst',
  },
  {
    defaultPrompt: rookPrompt,
    icon: '♖',
    id: 'r',
    name: 'Rooks',
    role: 'File commander',
  },
  {
    defaultPrompt: queenPrompt,
    icon: '♕',
    id: 'q',
    name: 'Queen',
    role: 'Field marshal',
  },
]

function cleanSan(san: string) {
  return san.replace(/[+#?!]/g, '')
}

function findLegalSan(legalMoves: Move[], san: string) {
  const target = cleanSan(san)
  return legalMoves.find((move) => move.san === san || cleanSan(move.san) === target)
}

function pieceName(piece: PieceSymbol) {
  const names: Record<PieceSymbol, string> = {
    b: 'bishop',
    k: 'king',
    n: 'knight',
    p: 'pawn',
    q: 'queen',
    r: 'rook',
  }
  return names[piece]
}

function materialBalanceFor(game: Chess, side: Color) {
  let white = 0
  let black = 0

  for (const row of game.board()) {
    for (const piece of row) {
      if (!piece) continue
      if (piece.color === 'w') white += pieceValues[piece.type]
      if (piece.color === 'b') black += pieceValues[piece.type]
    }
  }

  return side === 'w' ? white - black : black - white
}

function countNonKingPieces(game: Chess) {
  let count = 0
  for (const row of game.board()) {
    for (const piece of row) {
      if (piece && piece.type !== 'k') count += 1
    }
  }
  return count
}

function hasQueens(game: Chess) {
  for (const row of game.board()) {
    for (const piece of row) {
      if (piece?.type === 'q') return true
    }
  }
  return false
}

function addIfLegal(
  suggestions: KingDirectiveSuggestion[],
  legalMoves: Move[],
  san: string,
  label: string,
  text: string,
  priority: number,
) {
  if (!findLegalSan(legalMoves, san)) return
  suggestions.push({ label, priority, text })
}

function buildOpeningSuggestions(game: Chess, legalMoves: Move[], suggestions: KingDirectiveSuggestion[]) {
  const history = game.history()
  const halfMoves = history.length
  const side = game.turn()
  const lastMove = history[history.length - 1] ?? ''
  const openingText = (move: string, plan: string) => `Team, steer into ${move}. ${plan} Move when ready.`

  if (halfMoves === 0 && side === 'w') {
    addIfLegal(
      suggestions,
      legalMoves,
      'e4',
      'e4 mainline',
      openingText('1.e4', 'Build a top-tier king-pawn game: Nf3, Bc4 or Bb5, castle short, then fight for d4.'),
      82,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'd4',
      'd4 control',
      openingText("1.d4", "Aim for Queen's Gambit chess: c4, Nf3, clean development, and a durable center."),
      78,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Nf3',
      'Nf3 flex',
      openingText('1.Nf3', 'Keep e4, d4, and c4 options alive while developing fast and preserving king safety.'),
      72,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'c4',
      'English',
      openingText('1.c4', 'Clamp d5, build Nf3/g3/Bg2, and squeeze without early weaknesses.'),
      68,
    )
    return
  }

  if (halfMoves <= 1 && side === 'b' && lastMove === 'e4') {
    addIfLegal(
      suggestions,
      legalMoves,
      'e5',
      'classical',
      openingText('...e5', 'Play principled Open Game chess: develop Nc6/Nf6, contest d4, and castle before tactics open.'),
      82,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'c5',
      'Sicilian',
      openingText('...c5', 'Challenge the center from the flank and play for active queenside counterplay.'),
      80,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'c6',
      'Caro-Kann',
      openingText('...c6', 'Prepare ...d5, keep the structure solid, and make White prove the space advantage.'),
      73,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'e6',
      'French',
      openingText('...e6', 'Build the French center with ...d5 and prepare the ...c5 break.'),
      70,
    )
    return
  }

  if (halfMoves <= 1 && side === 'b' && lastMove === 'd4') {
    addIfLegal(
      suggestions,
      legalMoves,
      'Nf6',
      'Indian setup',
      openingText('...Nf6', 'Keep Nimzo, Queen’s Indian, King’s Indian, and Gruenfeld-style setups available.'),
      82,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'd5',
      'QGD setup',
      openingText('...d5', "Meet the center directly and be ready for a Queen's Gambit Declined structure."),
      78,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'e6',
      'solid dark',
      openingText('...e6', 'Stay flexible: Queen’s Gambit, Nimzo, or French transpositions are all live.'),
      70,
    )
    return
  }

  if (halfMoves < 12) {
    addIfLegal(
      suggestions,
      legalMoves,
      'Nf3',
      'develop',
      'Team, develop Nf3 if the square is clean. Hit the center, prepare castling, and avoid early queen adventures.',
      60,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Nf6',
      'develop',
      'Team, develop Nf6. Pressure the center, keep castling close, and make them show their pawn structure.',
      60,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Nc3',
      'center knight',
      'Team, bring the knight to c3. Support e4/d5 ideas and build a real center before launching anything.',
      58,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Nc6',
      'center knight',
      'Team, play Nc6. Contest d4/e5 and keep the opening honest.',
      58,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Bc4',
      'Italian',
      'Team, use Bc4 for Italian pressure. Aim at f7, castle short, and keep the center ready to open.',
      57,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Bb5',
      'Ruy Lopez',
      'Team, use Bb5 for Ruy Lopez pressure. Question the c6 knight, castle fast, and build d4 later.',
      57,
    )
    addIfLegal(
      suggestions,
      legalMoves,
      'Bc5',
      'active bishop',
      'Team, develop Bc5. Control the center, watch f2, and get the king safe before the board opens.',
      56,
    )
  }
}

function buildKingDirectiveSuggestions(game: Chess): KingDirectiveSuggestion[] {
  const legalMoves = game.moves({ verbose: true })
  if (legalMoves.length === 0) return []

  const suggestions: KingDirectiveSuggestion[] = []
  const side = sideName(game.turn())
  const halfMoves = game.history().length
  const balance = materialBalanceFor(game, game.turn())
  const isEndgame = countNonKingPieces(game) <= 10 || !hasQueens(game)
  const add = (label: string, text: string, priority: number) => {
    if (suggestions.some((suggestion) => suggestion.label === label || suggestion.text === text)) return
    suggestions.push({ label, priority, text })
  }
  const alreadySuggestsSan = (san: string) => {
    const target = cleanSan(san)
    return suggestions.some((suggestion) => cleanSan(suggestion.text).includes(target))
  }

  const mateMove = legalMoves.find((move) => move.san.includes('#'))
  if (mateMove) {
    add('mate now', `Team, ${mateMove.san} is mate. Confirm there is no legality issue and finish the game.`, 120)
  }

  if (game.inCheck()) {
    add(
      'solve check',
      `${side} is in check. Council, solve king safety first: prefer the cleanest legal escape, block, or capture. Move when ready.`,
      112,
    )
  }

  const queenCapture = legalMoves.find((move) => move.captured === 'q')
  if (queenCapture) {
    add(
      'win queen',
      `Team, ${queenCapture.san} can take the queen. Verify our king stays safe, then take the material.`,
      105,
    )
  }

  const bestCapture = [...legalMoves]
    .filter((move) => move.captured)
    .sort((a, b) => pieceValues[b.captured ?? 'p'] - pieceValues[a.captured ?? 'p'])[0]
  if (bestCapture && pieceValues[bestCapture.captured ?? 'p'] >= 3) {
    add(
      'take material',
      `Team, inspect ${bestCapture.san}. If the tactic holds, take the ${pieceName(bestCapture.captured ?? 'p')} and simplify the position.`,
      92,
    )
  }

  const checkingMove = legalMoves.find((move) => move.san.includes('+'))
  if (checkingMove) {
    add(
      'force check',
      `Team, consider ${checkingMove.san}. Use the check only if it wins tempo, material, or forces their king into a worse square.`,
      88,
    )
  }

  addIfLegal(
    suggestions,
    legalMoves,
    'O-O',
    'castle short',
    'Team, castle short now if the center is about to open. King safety first, then connect the rooks.',
    halfMoves < 14 ? 86 : 72,
  )
  addIfLegal(
    suggestions,
    legalMoves,
    'O-O-O',
    'castle long',
    'Team, castle long only if we want a sharper game. Check pawn cover and queenside safety before committing.',
    halfMoves < 14 ? 78 : 68,
  )

  buildOpeningSuggestions(game, legalMoves, suggestions)

  const centerBreak = legalMoves.find((move) => {
    const piece = game.get(move.from)
    return piece?.type === 'p' && centralSquares.has(move.to)
  })
  if (centerBreak) {
    if (!alreadySuggestsSan(centerBreak.san)) {
      add(
        'center break',
        `Team, test ${centerBreak.san}. If the center break is sound, open lines for our developed pieces.`,
        halfMoves < 16 ? 74 : 66,
      )
    }
  }

  const developingMove = legalMoves.find((move) => {
    const piece = game.get(move.from)
    return piece && ['n', 'b'].includes(piece.type) && !move.captured && centralSquares.has(move.to)
  })
  if (developingMove && halfMoves < 18) {
    if (!alreadySuggestsSan(developingMove.san)) {
      add(
        'develop piece',
        `Team, develop with ${developingMove.san}. Improve a minor piece, support the center, and keep castling available.`,
        64,
      )
    }
  }

  if (balance >= 3) {
    add(
      'convert edge',
      'Team, we are ahead. Favor clean trades, king safety, and moves that remove counterplay over flashy attacks.',
      58,
    )
  } else if (balance <= -3) {
    add(
      'create chaos',
      'Team, we need activity. Look for checks, captures, pawn breaks, and threats that make their advantage hard to convert.',
      58,
    )
  }

  if (isEndgame) {
    const kingMove = legalMoves.find((move) => {
      const piece = game.get(move.from)
      return piece?.type === 'k' && !move.san.includes('O-O')
    })
    if (kingMove) {
      add(
        'king active',
        `Team, endgame rules apply. Consider ${kingMove.san} if it activates the king without walking into tactics.`,
        62,
      )
    }
  }

  add(
    'best move',
    'Team, no agenda. Find the strongest legal move by checks, captures, threats, king safety, then long-term structure.',
    40,
  )

  return suggestions
    .sort((a, b) => b.priority - a.priority)
    .filter((suggestion, index, list) => list.findIndex((item) => item.label === suggestion.label) === index)
    .slice(0, 5)
}

function buildCouncilOpeningEvents(game: Chess, command: string, id: number): CouncilRoomEvent[] {
  const pieceClasses = new Set<string>()
  for (const move of game.moves({ verbose: true })) {
    const piece = game.get(move.from)
    if (piece && piece.type !== 'k') {
      pieceClasses.add(pieceClassRoomLabels[piece.type as Exclude<PieceSymbol, 'k'>])
    }
  }

  return [
    {
      actor: 'King',
      content: command,
      id,
      status: 'done',
      tone: 'king',
    },
    {
      actor: 'Board',
      content: `${sideName(game.turn())} is on the clock. The room has the position.`,
      id: id + 0.1,
      status: 'done',
      tone: 'system',
    },
    {
      actor: 'Council floor',
      content: `${[...pieceClasses].join(', ') || 'Legal pieces'} are warming up candidate lines.`,
      id: id + 0.2,
      status: 'pending',
      tone: 'system',
    },
    {
      actor: 'Match desk',
      content: 'Scouting clean moves and cutting the noise.',
      id: id + 0.3,
      status: 'pending',
      tone: 'system',
    },
  ]
}

function marketTraceEvent(event: PieceCouncilTraceEvent): PieceCouncilTraceEvent {
  const actor = event.actor.toLowerCase()
  const content = event.content

  if (actor.includes('ingress')) {
    return { ...event, actor: 'Match desk', content: 'Signal is in. The council room is live.' }
  }

  if (actor.includes('board parser')) {
    const side = content.includes('Black') ? 'Black' : 'White'
    return { ...event, actor: 'Board scout', content: `${side} has the move. Position is clean.` }
  }

  if (actor.includes('move arbiter')) {
    return {
      ...event,
      actor: 'Council desk',
      content: content.includes(':')
        ? `Best class calls on deck: ${content.split(':').slice(1).join(':').trim()}`
        : 'No clean class call is available from this position.',
    }
  }

  if (actor.includes('strategy director')) {
    return { ...event, actor: 'Strategy director', content: event.content.replace(/^.* ranked the plan:\s*/i, 'Council calls: ') }
  }

  if (actor.includes('router')) {
    return { ...event, actor: 'Oracle table', content: 'Polishing the strongest class takes for the board.' }
  }

  if (actor.includes('gemini') || actor.includes('local counsel')) {
    return { ...event, actor: 'Council desk', content: 'Suggestions are live. Pick the line you want to run.' }
  }

  if (actor.includes('server')) {
    return { ...event, actor: 'Match desk', content: 'The room missed the live feed, so local council stepped in.' }
  }

  return event
}

function traceToCouncilEvents(trace: PieceCouncilTraceEvent[] | undefined, baseId: number): CouncilRoomEvent[] {
  return (trace ?? []).map((rawEvent, index) => {
    const event = marketTraceEvent(rawEvent)
    return {
      actor: event.actor,
      content: event.content,
      id: baseId + index,
      status: event.status ?? 'done',
      tone: 'system' as const,
    }
  })
}

function classMoveLine(san: string, content: string) {
  return `${san} is the call. ${content.replace(/^King,\s*/i, '')}`
}

function replyToCouncilEvent(reply: { content: string; move: { san: string }; sender: string }, id: number): CouncilRoomEvent {
  return {
    actor: reply.sender,
    content: classMoveLine(reply.move.san, reply.content),
    id,
    status: 'done',
    tone: 'piece',
  }
}

function councilActorIcon(actor: string, tone?: CouncilRoomEvent['tone']) {
  const normalized = actor.toLowerCase()
  if (tone === 'king' || normalized.includes('king')) return '♔'
  if (normalized.includes('castle') || normalized.includes('royal')) return '♔'
  if (normalized.includes('pawn')) return '♙'
  if (normalized.includes('knight')) return '♘'
  if (normalized.includes('bishop')) return '♗'
  if (normalized.includes('rook')) return '♖'
  if (normalized.includes('queen')) return '♕'
  if (normalized.includes('board')) return 'B'
  if (normalized.includes('backend') || normalized.includes('router') || normalized.includes('server')) return 'S'
  return 'C'
}

function councilActorClass(actor: string, tone?: CouncilRoomEvent['tone']) {
  const normalized = actor.toLowerCase()
  if (tone === 'king' || normalized.includes('king')) return 'king'
  if (
    normalized.includes('castle') ||
    normalized.includes('royal') ||
    normalized.includes('pawn') ||
    normalized.includes('knight') ||
    normalized.includes('bishop') ||
    normalized.includes('rook') ||
    normalized.includes('queen')
  ) {
    return 'piece'
  }
  return 'system'
}

function councilActorBadge(actorClass: string, status?: CouncilRoomEvent['status']) {
  if (status === 'pending') return 'scouting'
  if (status === 'blocked') return 'flagged'
  if (actorClass === 'king') return 'king'
  if (actorClass === 'piece') return 'class'
  return 'host'
}

function CouncilRoom({
  children,
  events,
  isThinking,
}: {
  children: ReactNode
  events: CouncilRoomEvent[]
  isThinking: boolean
}) {
  return (
    <aside className="council-room" aria-label="Council room">
      <div className="council-room-heading">
        <div>
          <p className="eyebrow">Council room</p>
        </div>
        <span className="council-live">Live</span>
        {isThinking && <LoaderCircle className="send-spinner" size={16} />}
      </div>
      <div className="council-room-feed" aria-live="polite">
        {events.length === 0 ? (
          <article className="council-event muted">
            <span className="council-avatar system">C</span>
            <div className="council-bubble">
              <div className="council-line-meta">
                <strong>Waiting</strong>
                <span>idle</span>
              </div>
              <p>Send a command to watch the council coordinate before suggestions hit the board.</p>
            </div>
          </article>
        ) : (
          events.map((event) => {
            const actorClass = councilActorClass(event.actor, event.tone)
            return (
              <article
                className={`council-event ${event.tone ?? 'system'} ${event.status ?? 'done'} ${actorClass}`}
                key={event.id}
              >
                <span className={`council-avatar ${actorClass}`}>{councilActorIcon(event.actor, event.tone)}</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>{event.actor}</strong>
                    <span>{councilActorBadge(actorClass, event.status)}</span>
                  </div>
                  <p>{event.content}</p>
                </div>
              </article>
            )
          })
        )}
      </div>
      {children}
    </aside>
  )
}

function AgentPromptRail({
  activeId,
  promptOverrides,
  onSelect,
}: {
  activeId: PromptClassId | null
  promptOverrides: Partial<Record<PromptClassId, string>>
  onSelect: (id: PromptClassId) => void
}) {
  return (
    <aside className="agent-prompt-rail" aria-label="Agent class prompts">
      {promptClassDefinitions.map((agent) => {
        const edited = Boolean(promptOverrides[agent.id])
        return (
          <button
            type="button"
            className={`agent-prompt-button ${activeId === agent.id ? 'active' : ''}`}
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            title={`${agent.name} master prompt`}
          >
            <span className="agent-prompt-icon">{agent.icon}</span>
            <span className="agent-prompt-copy">
              <strong>{agent.name}</strong>
              <span>{agent.role}</span>
            </span>
            {edited && <span className="agent-model-pill edited">Tuned</span>}
          </button>
        )
      })}
    </aside>
  )
}

function PromptEditorModal({
  agent,
  prompt,
  textSize,
  onChange,
  onClose,
  onReset,
  onTextSizeChange,
}: {
  agent: PromptClassDefinition
  prompt: string
  textSize: number
  onChange: (value: string) => void
  onClose: () => void
  onReset: () => void
  onTextSizeChange: (value: number) => void
}) {
  return (
    <div className="prompt-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} master prompt`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="prompt-modal-header">
          <span className="prompt-modal-icon">{agent.icon}</span>
          <div>
            <p className="eyebrow">{agent.role}</p>
            <h2>{agent.name}</h2>
          </div>
          <button type="button" className="prompt-modal-close" onClick={onClose} aria-label="Close prompt editor">
            <X size={15} />
          </button>
        </header>

        <div className="prompt-toolbar" aria-label="Prompt text settings">
          <button type="button" onClick={() => onTextSizeChange(textSize - 1)} aria-label="Decrease prompt text size">
            A-
          </button>
          <span>{textSize}px</span>
          <button type="button" onClick={() => onTextSizeChange(textSize + 1)} aria-label="Increase prompt text size">
            A+
          </button>
          <button type="button" onClick={onReset}>
            Reset
          </button>
        </div>

        <textarea
          className="prompt-editor"
          value={prompt}
          onChange={(event) => onChange(event.target.value)}
          style={{ fontSize: `${textSize}px` }}
        />
      </section>
    </div>
  )
}

function CapturedRow({ side, pieces }: { side: Color; pieces: PieceSymbol[] }) {
  const score = pieces.reduce((sum, p) => sum + pieceValues[p], 0)
  return (
    <div className={`captured-row ${side === 'w' ? 'white' : 'black'}`}>
      {pieces.map((p, i) => (
        <span key={`${p}-${i}`} className="captured-piece">
          {capturedGlyphs[p]}
        </span>
      ))}
      {score > 0 && <span className="captured-score">+{score}</span>}
    </div>
  )
}

function LocalGame() {
  const savedSession = useMemo(() => loadSavedGameSession(), [])
  const [game, setGame] = useState(() => createGameFromSession(savedSession))
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(() => savedSession.lastMove)
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    createTurnIntro(game.turn(), game.history().length),
  ])
  const [threadHistory, setThreadHistory] = useState<TurnThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState('current')
  const [draft, setDraft] = useState('')
  const [isCouncilThinking, setCouncilThinking] = useState(false)
  const [boardReplies, setBoardReplies] = useState<PieceReplyBubble[]>([])
  const [previewMove, setPreviewMove] = useState<PieceMoveSuggestion | null>(null)
  const [councilRoomEvents, setCouncilRoomEvents] = useState<CouncilRoomEvent[]>([])
  const [activeStrategy, setActiveStrategy] = useState('')
  const [autopilotEnabled, setAutopilotEnabled] = useState(false)
  const [pendingCouncilQuestion, setPendingCouncilQuestion] = useState('')
  const [promptOverrides, setPromptOverrides] = useState<Partial<Record<PromptClassId, string>>>(() => loadPromptOverrides())
  const [activePromptClass, setActivePromptClass] = useState<PromptClassId | null>(null)
  const [promptTextSizes, setPromptTextSizes] = useState<PromptTextSizes>(() => loadPromptTextSizes())
  const activeStrategyRef = useRef('')
  const autopilotEnabledRef = useRef(false)
  const councilRunIdRef = useRef(0)
  const autopilotRunKeyRef = useRef('')
  const autopilotTimerRef = useRef<number | null>(null)

  const legalMoves = useMemo(() => {
    if (!selectedSquare) return []
    return game.moves({ square: selectedSquare, verbose: true })
  }, [game, selectedSquare])

  const moveHistory = useMemo(() => game.history({ verbose: true }), [game])

  const captured = useMemo(() => {
    const result: Record<Color, PieceSymbol[]> = { w: [], b: [] }
    for (const move of moveHistory) {
      if (!move.captured) continue
      const victimColor: Color = move.color === 'w' ? 'b' : 'w'
      result[victimColor].push(move.captured)
    }
    const order: PieceSymbol[] = ['q', 'r', 'b', 'n', 'p']
    const rank = (p: PieceSymbol) => order.indexOf(p)
    result.w.sort((a, b) => rank(a) - rank(b))
    result.b.sort((a, b) => rank(a) - rank(b))
    return result
  }, [moveHistory])

  const isViewingArchive = selectedThreadId !== 'current'
  const activePromptDefinition = promptClassDefinitions.find((agent) => agent.id === activePromptClass) ?? null
  const activePromptText = activePromptDefinition
    ? (promptOverrides[activePromptDefinition.id] ?? activePromptDefinition.defaultPrompt)
    : ''
  const activePromptTextSize = activePromptDefinition ? (promptTextSizes[activePromptDefinition.id] ?? 13) : 13
  const directiveSuggestions = useMemo(() => buildKingDirectiveSuggestions(game), [game])

  useEffect(() => {
    activeStrategyRef.current = activeStrategy
  }, [activeStrategy])

  useEffect(() => {
    autopilotEnabledRef.current = autopilotEnabled
  }, [autopilotEnabled])

  useEffect(() => {
    const storage = getSessionStorage()
    if (!storage) return

    const session: SavedGameSession = {
      lastMove,
      pgn: game.pgn(),
    }
    storage.setItem(gameSessionKey, JSON.stringify(session))
  }, [game, lastMove])

  useEffect(() => {
    const storage = getLocalStorage()
    if (!storage) return

    storage.setItem(promptOverridesKey, JSON.stringify(promptOverrides))
  }, [promptOverrides])

  useEffect(() => {
    const storage = getLocalStorage()
    if (!storage) return

    storage.setItem(promptTextSizeKey, JSON.stringify(promptTextSizes))
  }, [promptTextSizes])

  const commitMove = useCallback(
    (from: Square, to: Square, promotion: PieceSymbol = 'q') => {
      const legalMove = game
        .moves({ square: from, verbose: true })
        .find((move) => move.to === to && (!move.promotion || move.promotion === promotion))

      if (!legalMove) return false

      const next = cloneGame(game)
      const move = next.move({ from, to, promotion: legalMove.promotion ?? promotion })
      const boardMessage: ChatMessage = {
        id: Date.now() + Math.random(),
        role: 'system',
        sender: 'Board',
        subtitle: 'move committed',
        content: describeMove(move),
      }
      const archivedMessages = [...messages, boardMessage]
      const turnTitle = currentThreadTitle(game)

      setGame(next)
      setSelectedSquare(null)
      setLastMove({ from: move.from, to: move.to })
      setBoardReplies([])
      setPreviewMove(null)
      setThreadHistory((current) => [
        {
          id: `${move.lan}-${Date.now()}`,
          messages: archivedMessages,
          subtitle: `Completed with ${move.san}`,
          title: turnTitle,
        },
        ...current,
      ])
      setMessages([createTurnIntro(next.turn(), next.history().length)])
      setSelectedThreadId('current')
      return true
    },
    [game, messages],
  )

  const handleSquareSelect = useCallback(
    (square: Square) => {
      if (isCouncilThinking || autopilotEnabled) return

      const piece = game.get(square)

      if (selectedSquare) {
        const validTarget = legalMoves.some((move) => move.to === square)
        if (validTarget && commitMove(selectedSquare, square)) {
          return
        }
      }

      if (piece && piece.color === game.turn()) {
        setPreviewMove(null)
        setSelectedSquare(square)
        return
      }

      setSelectedSquare(null)
    },
    [autopilotEnabled, commitMove, game, isCouncilThinking, legalMoves, selectedSquare],
  )

  const previewSuggestion = useCallback(
    (suggestion: PieceMoveSuggestion) => {
      if (isViewingArchive) return
      setSelectedSquare(null)
      setPreviewMove(suggestion)
    },
    [isViewingArchive],
  )

  const approveSuggestion = useCallback(
    (suggestion: PieceMoveSuggestion) => {
      if (isCouncilThinking || isViewingArchive) return
      commitMove(suggestion.from, suggestion.to, suggestion.promotion ?? 'q')
    },
    [commitMove, isCouncilThinking, isViewingArchive],
  )

  const runCouncilTurn = useCallback(
    async (command: string, mode: 'auto' | 'suggest') => {
      const trimmed = command.trim()
      if (!trimmed || isViewingArchive) return

      if (isTerminalGame(game)) {
        setAutopilotEnabled(false)
        return
      }

      const runId = councilRunIdRef.current + 1
      councilRunIdRef.current = runId
      const isCurrentRun = () => councilRunIdRef.current === runId

      if (mode === 'auto') {
        autopilotRunKeyRef.current = `${game.fen()}::${trimmed}`
      }

      const sideToMove = game.turn() === 'w' ? 'White' : 'Black'
      const id = Date.now()
      setSelectedThreadId('current')
      setBoardReplies([])
      setPreviewMove(null)
      setPendingCouncilQuestion('')
      setCouncilRoomEvents(buildCouncilOpeningEvents(game, trimmed, id))
      setMessages((current) => [
        ...current,
        {
          avatar: '♚',
          id,
          role: 'king',
          sender: 'King',
          subtitle: `${sideToMove} strategy`,
          content: trimmed,
        },
      ])
      setCouncilThinking(true)

      try {
        const result = await requestPieceCouncil(game, trimmed, 3, promptOverrides)
        if (!isCurrentRun()) return

        const sourceLabel = result.source === 'gemini' ? 'Council' : 'local counsel'
        const traceEvents = traceToCouncilEvents(result.trace, id + 100)

        if (result.terminal) {
          const terminalMessage = result.terminal
          setAutopilotEnabled(false)
          setBoardReplies([])
          setPreviewMove(null)
          setCouncilRoomEvents((current) => [
            ...current.filter((event) => event.status !== 'pending'),
            ...traceEvents,
            {
              actor: 'Board',
              content: terminalMessage,
              id: id + 200,
              status: 'blocked',
              tone: 'system',
            },
          ])
          setMessages((current) => [
            ...current,
            {
              id: id + 1,
              role: 'system',
              sender: 'Board',
              subtitle: 'terminal position',
              content: terminalMessage,
            },
          ])
          return
        }

        const councilQuestion = result.question
        if (councilQuestion) {
          setAutopilotEnabled(false)
          setBoardReplies([])
          setPreviewMove(null)
          setPendingCouncilQuestion(councilQuestion)
          setCouncilRoomEvents((current) => [
            ...current.filter((event) => event.status !== 'pending'),
            ...traceEvents,
            {
              actor: 'Council question',
              content: result.questionOptions?.length
                ? `${councilQuestion} ${result.questionOptions.join(' / ')}`
                : councilQuestion,
              id: id + 200,
              status: 'pending',
              tone: 'system',
            },
          ])
          setMessages((current) => [
            ...current,
            {
              id: id + 1,
              role: 'system',
              sender: 'Council question',
              subtitle: sourceLabel,
              content: councilQuestion,
            },
          ])
          return
        }

        if (result.replies.length === 0) {
          setAutopilotEnabled(false)
          setBoardReplies([])
          setPreviewMove(null)
          setCouncilRoomEvents((current) => [
            ...current.filter((event) => event.status !== 'pending'),
            ...traceEvents,
            {
              actor: 'Council floor',
              content: 'No clean council line is available from this spot.',
              id: id + 200,
              status: 'blocked',
              tone: 'system',
            },
          ])
          setMessages((current) => [
            ...current,
            {
              id: id + 1,
              role: 'system',
              sender: 'Piece council',
              subtitle: sourceLabel,
              content: 'No non-king piece has a legal response to that command from this position.',
            },
          ])
          return
        }

        const pieceMessages = result.replies.map((reply, index) => {
          return {
            avatar: reply.avatar,
            content: reply.content,
            id: id + index + 1,
            role: 'piece' as const,
            sender: reply.sender,
            subtitle: `${reply.subtitle} · ${sourceLabel}`,
          }
        })
        const replyBubbles = result.replies.map((reply, index) => ({
          avatar: reply.avatar,
          content: reply.content,
          id: id + index + 1,
          sender: reply.sender,
          suggestion: toSuggestion(reply.move),
          square: reply.from,
          subtitle: `${reply.subtitle} · ${sourceLabel}`,
        }))
        const topReply = result.replies[0]

        setBoardReplies(replyBubbles)
        setPreviewMove(toSuggestion(topReply.move))
        setCouncilRoomEvents((current) => [
          ...current.filter((event) => event.status !== 'pending'),
          ...traceEvents,
          ...result.replies.map((reply, index) => replyToCouncilEvent(reply, id + 200 + index)),
          ...(mode === 'auto'
            ? [
                {
                  actor: 'Autopilot',
                  content: `${topReply.move.san} is locked. The board will make it now.`,
                  id: id + 300,
                  status: 'pending' as const,
                  tone: 'system' as const,
                },
              ]
            : []),
        ])
        setMessages((current) => [...current, ...pieceMessages])

        if (mode === 'auto') {
          await sleep(900)
          if (isCurrentRun() && autopilotEnabledRef.current && activeStrategyRef.current === trimmed) {
            const committed = commitMove(topReply.move.from, topReply.move.to, topReply.move.promotion ?? 'q')
            if (!committed) setAutopilotEnabled(false)
          }
        }
      } finally {
        if (isCurrentRun()) {
          setCouncilThinking(false)
        }
      }
    },
    [commitMove, game, isViewingArchive, promptOverrides],
  )

  const submitDirective = useCallback(async (directive: string) => {
    const trimmed = directive.trim()
    if (!trimmed || isViewingArchive) return

    setDraft('')
    setActiveStrategy(trimmed)
    setAutopilotEnabled(true)
    setPendingCouncilQuestion('')
    activeStrategyRef.current = trimmed
    autopilotEnabledRef.current = true
    await runCouncilTurn(trimmed, 'auto')
  }, [isViewingArchive, runCouncilTurn])

  const sendMessage = useCallback(async () => {
    await submitDirective(draft)
  }, [draft, submitDirective])

  useEffect(() => {
    if (!autopilotEnabled || !activeStrategy.trim() || isCouncilThinking || isViewingArchive) return

    if (isTerminalGame(game)) {
      setAutopilotEnabled(false)
      return
    }

    const key = `${game.fen()}::${activeStrategy}`
    if (autopilotRunKeyRef.current === key || autopilotTimerRef.current !== null) return

    autopilotTimerRef.current = window.setTimeout(() => {
      autopilotTimerRef.current = null
      if (autopilotRunKeyRef.current === key) return
      void runCouncilTurn(activeStrategy, 'auto')
    }, 900)

    return () => {
      if (autopilotTimerRef.current !== null) {
        window.clearTimeout(autopilotTimerRef.current)
        autopilotTimerRef.current = null
      }
    }
  }, [activeStrategy, autopilotEnabled, game, isCouncilThinking, isViewingArchive, runCouncilTurn])

  return (
    <main className="app-shell">
      <div className="workspace-layout">
        <AgentPromptRail activeId={activePromptClass} promptOverrides={promptOverrides} onSelect={setActivePromptClass} />
        <CouncilRoom events={councilRoomEvents} isThinking={isCouncilThinking}>
          <div className="directive-suggestions" aria-label="Suggested royal directives">
            {directiveSuggestions.map((suggestion) => (
              <button
                type="button"
                className="directive-chip"
                key={suggestion.label}
                onClick={() => {
                  void submitDirective(suggestion.text)
                }}
                title={suggestion.text}
                disabled={isViewingArchive}
              >
                <span>{suggestion.label}</span>
                <strong>{suggestion.text}</strong>
              </button>
            ))}
          </div>
          <div className={`composer council-composer ${isCouncilThinking ? 'thinking' : ''}`}>
            <select
              className="composer-history"
              aria-label="Thread history"
              value={selectedThreadId}
              onChange={(event) => setSelectedThreadId(event.target.value)}
            >
              <option value="current">{currentThreadTitle(game)} · active</option>
              {threadHistory.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title} · {thread.subtitle}
                </option>
              ))}
            </select>
            <div className="council-composer-row">
              <textarea
                aria-label="Command your piece council"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    sendMessage()
                  }
                }}
                placeholder={
                  isViewingArchive
                    ? 'Viewing archived turn thread'
                    : pendingCouncilQuestion
                      ? 'Answer the council...'
                    : activeStrategy
                      ? `Steer: ${activeStrategy}`
                      : 'Give the king strategy...'
                }
                disabled={isViewingArchive}
              />
              {autopilotEnabled ? (
                <button
                  type="button"
                  className="composer-status"
                  onClick={() => setAutopilotEnabled(false)}
                  aria-label="Pause autopilot"
                >
                  {isCouncilThinking && <LoaderCircle className="send-spinner" size={14} />}
                  <span>Pause</span>
                </button>
              ) : (
                isCouncilThinking && (
                  <div className="composer-status" role="status" aria-live="polite">
                    <LoaderCircle className="send-spinner" size={14} />
                    <span>Thinking</span>
                  </div>
                )
              )}
              <button
                type="button"
                onClick={sendMessage}
                aria-label="Send message"
                disabled={!draft.trim() || isViewingArchive}
              >
                <CornerDownLeft size={18} />
              </button>
            </div>
          </div>
        </CouncilRoom>
        <section className="board-workspace" aria-label="Chess workspace">
          <CapturedRow side="b" pieces={captured.b} />

          <div className="scene-shell">
            <FlatChessBoard
              game={game}
              selectedSquare={selectedSquare}
              legalTargets={legalMoves.map((move) => move.to)}
              lastMove={lastMove}
              previewMove={selectedThreadId === 'current' ? previewMove : null}
              replyBubbles={selectedThreadId === 'current' ? boardReplies : []}
              onApproveSuggestion={approveSuggestion}
              onPreviewSuggestion={previewSuggestion}
              onSquareSelect={handleSquareSelect}
            />
          </div>

          <CapturedRow side="w" pieces={captured.w} />

          <footer className="move-strip" aria-label="Move history">
            {moveHistory.length === 0 ? (
              <span>No moves yet</span>
            ) : (
              moveHistory.slice(-12).map((move, index) => (
                <span key={`${move.from}-${move.to}-${index}`}>{move.san}</span>
              ))
            )}
          </footer>
        </section>
      </div>
      {activePromptDefinition && (
        <PromptEditorModal
          agent={activePromptDefinition}
          prompt={activePromptText}
          textSize={activePromptTextSize}
          onChange={(value) => {
            setPromptOverrides((current) => ({
              ...current,
              [activePromptDefinition.id]: value,
            }))
          }}
          onClose={() => setActivePromptClass(null)}
          onReset={() => {
            setPromptOverrides((current) => {
              const next = { ...current }
              delete next[activePromptDefinition.id]
              return next
            })
          }}
          onTextSizeChange={(value) => {
            setPromptTextSizes((current) => ({
              ...current,
              [activePromptDefinition.id]: clampPromptTextSize(value),
            }))
          }}
        />
      )}
    </main>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Lobby />} />
      <Route path="/local" element={<LocalGame />} />
      <Route path="/game/:gameId" element={<MultiplayerGame />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
