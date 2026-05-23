import { useCallback, useMemo, useState } from 'react'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { Bot, CornerDownLeft, User } from 'lucide-react'
import { FlatChessBoard } from './components/FlatChessBoard'
import { requestPieceCouncil } from './lib/pieceCouncilClient'

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

function App() {
  const [game, setGame] = useState(() => new Chess())
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [lastMove, setLastMove] = useState<{ from: Square; to: Square } | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => [createTurnIntro('w', 0)])
  const [threadHistory, setThreadHistory] = useState<TurnThread[]>([])
  const [selectedThreadId, setSelectedThreadId] = useState('current')
  const [draft, setDraft] = useState('')
  const [isCouncilThinking, setCouncilThinking] = useState(false)

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

  const displayedMessages = useMemo(() => {
    if (selectedThreadId === 'current') return messages
    return threadHistory.find((thread) => thread.id === selectedThreadId)?.messages ?? messages
  }, [messages, selectedThreadId, threadHistory])

  const isViewingArchive = selectedThreadId !== 'current'

  const handleSquareSelect = useCallback(
    (square: Square) => {
      if (isCouncilThinking) return

      const piece = game.get(square)

      if (selectedSquare) {
        const validTarget = legalMoves.some((move) => move.to === square)
        if (validTarget) {
          const next = cloneGame(game)
          const move = next.move({ from: selectedSquare, to: square, promotion: 'q' })
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
          return
        }
      }

      if (piece && piece.color === game.turn()) {
        setSelectedSquare(square)
        return
      }

      setSelectedSquare(null)
    },
    [game, isCouncilThinking, legalMoves, messages, selectedSquare],
  )

  const sendMessage = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed || isCouncilThinking || isViewingArchive) return

    const sideToMove = game.turn() === 'w' ? 'White' : 'Black'
    const id = Date.now()
    setDraft('')
    setSelectedThreadId('current')
    setMessages((current) => [
      ...current,
      {
        avatar: '♚',
        id,
        role: 'king',
        sender: 'King',
        subtitle: `${sideToMove} command`,
        content: trimmed,
      },
    ])
    setCouncilThinking(true)

    const result = await requestPieceCouncil(game, trimmed, 3)
    const sourceLabel = result.source === 'gemini' ? 'Gemini counsel' : 'local counsel'

    setMessages((current) => {
      if (result.terminal) {
        return [
          ...current,
          {
            id: id + 1,
            role: 'system',
            sender: 'Board',
            subtitle: 'terminal position',
            content: result.terminal,
          },
        ]
      }

      if (result.replies.length === 0) {
        return [
          ...current,
          {
            id: id + 1,
            role: 'system',
            sender: 'Piece council',
            subtitle: sourceLabel,
            content: 'No non-king piece has a legal response to that command from this position.',
          },
        ]
      }

      return [
        ...current,
        ...result.replies.map((reply, index) => ({
          avatar: reply.avatar,
          content: reply.content,
          id: id + index + 1,
          role: 'piece' as const,
          sender: reply.sender,
          subtitle: `${reply.subtitle} · ${sourceLabel}`,
        })),
      ]
    })
    setCouncilThinking(false)
  }, [draft, game, isCouncilThinking, isViewingArchive])

  return (
    <main className="app-shell">
      <section className="board-workspace" aria-label="Chess workspace">
        <CapturedRow side="b" pieces={captured.b} />

        <div className="scene-shell">
          <FlatChessBoard
            game={game}
            selectedSquare={selectedSquare}
            legalTargets={legalMoves.map((move) => move.to)}
            lastMove={lastMove}
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

      <aside className="chat-panel" aria-label="Agent chat">
        <div className="chat-heading">
          <div>
            <p className="eyebrow">Thread</p>
            <h2>Piece council</h2>
          </div>
          <div className="thread-actions">
            <select
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
            <Bot size={22} />
          </div>
        </div>

        <div className="message-list">
          {displayedMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-icon">
                {message.avatar ?? (message.role === 'king' ? <User size={16} /> : <Bot size={16} />)}
              </div>
              <div className="message-bubble">
                <div className="message-meta">
                  <strong>{message.sender}</strong>
                  {message.subtitle && <span>{message.subtitle}</span>}
                </div>
                <p>{message.content}</p>
              </div>
            </article>
          ))}
          {isCouncilThinking && (
            <article className="message system">
              <div className="message-icon">
                <Bot size={16} />
              </div>
              <div className="message-bubble">
                <div className="message-meta">
                  <strong>Piece council</strong>
                  <span>reading the board</span>
                </div>
                <p>Checking legal candidates against your command...</p>
              </div>
            </article>
          )}
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
            placeholder={isViewingArchive ? 'Viewing archived turn thread' : 'Command your pieces as king...'}
            disabled={isViewingArchive}
          />
          <button
            type="button"
            onClick={sendMessage}
            aria-label="Send message"
            disabled={isCouncilThinking || isViewingArchive}
          >
            <CornerDownLeft size={18} />
          </button>
        </div>
      </aside>
    </main>
  )
}

export default App
