import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { CornerDownLeft, LoaderCircle } from 'lucide-react'
import { Navigate, Route, Routes } from 'react-router-dom'
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

const gameSessionKey = 'agentic-chess:game-session:v1'

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
  const activeStrategyRef = useRef('')
  const autopilotEnabledRef = useRef(false)
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
      if (!trimmed || isCouncilThinking || isViewingArchive) return

      if (isTerminalGame(game)) {
        setAutopilotEnabled(false)
        return
      }

      if (mode === 'auto') {
        autopilotRunKeyRef.current = `${game.fen()}::${trimmed}`
      }

      const sideToMove = game.turn() === 'w' ? 'White' : 'Black'
      const id = Date.now()
      setSelectedThreadId('current')
      setBoardReplies([])
      setPreviewMove(null)
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
        const result = await requestPieceCouncil(game, trimmed, 3)
        const sourceLabel = result.source === 'gemini' ? 'Gemini counsel' : 'local counsel'
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
          if (autopilotEnabledRef.current && activeStrategyRef.current === trimmed) {
            const committed = commitMove(topReply.move.from, topReply.move.to, topReply.move.promotion ?? 'q')
            if (!committed) setAutopilotEnabled(false)
          }
        }
      } finally {
        setCouncilThinking(false)
      }
    },
    [commitMove, game, isCouncilThinking, isViewingArchive],
  )

  const sendMessage = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed || isCouncilThinking || isViewingArchive) return

    setDraft('')
    setActiveStrategy(trimmed)
    setAutopilotEnabled(true)
    activeStrategyRef.current = trimmed
    autopilotEnabledRef.current = true
    await runCouncilTurn(trimmed, 'auto')
  }, [draft, isCouncilThinking, isViewingArchive, runCouncilTurn])

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
        <CouncilRoom events={councilRoomEvents} isThinking={isCouncilThinking}>
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
                    : activeStrategy
                      ? `Steer: ${activeStrategy}`
                      : 'Give the king strategy...'
                }
                disabled={isCouncilThinking || isViewingArchive}
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
                disabled={isCouncilThinking || isViewingArchive}
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
