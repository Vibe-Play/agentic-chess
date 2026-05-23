import { useCallback, useMemo, useState } from 'react'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { Bot, CornerDownLeft, User } from 'lucide-react'
import { FlatChessBoard } from './components/FlatChessBoard'

type ChatMessage = {
  id: number
  role: 'agent' | 'player'
  content: string
}

const initialMessages: ChatMessage[] = [
  {
    id: 1,
    role: 'agent',
    content: 'Board initialized. I can track legal moves, explain the current position, and suggest a candidate move.',
  },
]

function cloneGame(game: Chess) {
  return new Chess(game.fen())
}

function describeMove(move: Move) {
  const capture = move.captured ? ' captures' : ''
  const suffix = move.san.includes('+') ? ' with check' : move.san.includes('#') ? ' with mate' : ''
  return `${move.color === 'w' ? 'White' : 'Black'}: ${move.from}-${move.to}${capture} (${move.san})${suffix}`
}

function chooseCandidateMove(game: Chess) {
  const moves = game.moves({ verbose: true })
  if (moves.length === 0) return null

  const checkmate = moves.find((move) => move.san.includes('#'))
  if (checkmate) return checkmate

  const checking = moves.find((move) => move.san.includes('+'))
  if (checking) return checking

  const capture = moves.find((move) => move.captured)
  if (capture) return capture

  const center = moves.find((move) => ['d4', 'e4', 'd5', 'e5'].includes(move.to))
  return center ?? moves[0]
}

function agentReply(prompt: string, game: Chess) {
  const normalized = prompt.toLowerCase()
  const turn = game.turn() === 'w' ? 'White' : 'Black'

  if (game.isCheckmate()) {
    return `Checkmate is on the board. ${game.turn() === 'w' ? 'Black' : 'White'} has won.`
  }

  if (game.isDraw()) {
    return 'The position is drawn by the current chess.js rules.'
  }

  if (normalized.includes('suggest') || normalized.includes('move') || normalized.includes('best')) {
    const candidate = chooseCandidateMove(game)
    if (!candidate) return 'There are no legal moves from this position.'
    return `Candidate for ${turn}: ${candidate.san}. It is legal, ${candidate.captured ? 'wins material' : 'keeps the position moving'}, and the board is ready to animate it.`
  }

  if (normalized.includes('status') || normalized.includes('position') || normalized.includes('turn')) {
    const legalCount = game.moves().length
    const check = game.inCheck() ? ' The side to move is in check.' : ''
    return `${turn} to move. ${legalCount} legal moves are available.${check}`
  }

  if (normalized.includes('undo')) {
    return 'Undo is not exposed in the current minimal board surface. I can add it back as a small in-scene control later if needed.'
  }

  return `${turn} to move. Ask for a suggestion or click a piece to inspect its legal destinations.`
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

function CapturedRow({ side, pieces }: { side: Color; pieces: PieceSymbol[] }) {
  const label = side === 'w' ? 'White lost' : 'Black lost'
  const score = pieces.reduce((sum, p) => sum + pieceValues[p], 0)
  return (
    <div className={`captured-row ${side === 'w' ? 'white' : 'black'}`}>
      <span className="captured-label">{label}</span>
      <div className="captured-pieces">
        {pieces.length === 0 ? (
          <span className="captured-empty">—</span>
        ) : (
          pieces.map((p, i) => (
            <span key={`${p}-${i}`} className="captured-piece">
              {capturedGlyphs[p]}
            </span>
          ))
        )}
      </div>
      {score > 0 && <span className="captured-score">{score}</span>}
    </div>
  )
}

function App() {
  const [game, setGame] = useState(() => new Chess())
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [draft, setDraft] = useState('')

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

  const appendAgentMessage = useCallback((content: string) => {
    setMessages((current) => [
      ...current,
      {
        id: Date.now() + Math.random(),
        role: 'agent',
        content,
      },
    ])
  }, [])

  const handleSquareSelect = useCallback(
    (square: Square) => {
      const piece = game.get(square)

      if (selectedSquare) {
        const validTarget = legalMoves.some((move) => move.to === square)
        if (validTarget) {
          const next = cloneGame(game)
          const move = next.move({ from: selectedSquare, to: square, promotion: 'q' })
          setGame(next)
          setSelectedSquare(null)
          setLastMove({ from: move.from, to: move.to })
          appendAgentMessage(describeMove(move))
          return
        }
      }

      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square)
        return
      }

      setSelectedSquare(null)
    },
    [appendAgentMessage, game, legalMoves, selectedSquare],
  )

  const sendMessage = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed) return

    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        role: 'player',
        content: trimmed,
      },
      {
        id: Date.now() + 1,
        role: 'agent',
        content: agentReply(trimmed, game),
      },
    ])
    setDraft('')
  }, [draft, game])

  return (
    <main className="app-shell">
      <section className="board-workspace" aria-label="3D chess workspace">
        <div className="scene-shell">
          <FlatChessBoard
            game={game}
            selectedSquare={selectedSquare}
            legalTargets={legalMoves.map((move) => move.to)}
            lastMove={lastMove}
            onSquareSelect={handleSquareSelect}
          />
        </div>

        <div className="captured-strip" aria-label="Captured pieces">
          <CapturedRow side="b" pieces={captured.b} />
          <CapturedRow side="w" pieces={captured.w} />
        </div>

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

      <aside className="chat-panel" aria-label="Agent chat">
        <div className="chat-heading">
          <div>
            <p className="eyebrow">Sidecar</p>
            <h2>Agent chat</h2>
          </div>
          <Bot size={22} />
        </div>

        <div className="message-list">
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-icon">{message.role === 'agent' ? <Bot size={16} /> : <User size={16} />}</div>
              <p>{message.content}</p>
            </article>
          ))}
        </div>

        <div className="composer">
          <textarea
            aria-label="Message the chess agent"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                sendMessage()
              }
            }}
            placeholder="Ask for a move, status, or plan..."
          />
          <button type="button" onClick={sendMessage} aria-label="Send message">
            <CornerDownLeft size={18} />
          </button>
        </div>
      </aside>
    </main>
  )
}

export default App
