import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'
import { Check, Copy, CornerDownLeft, Home, Link2, LoaderCircle, WifiOff } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { CapturedRow, captureSummary } from '../components/CapturedRow'
import { FlatChessBoard, type PieceMoveSuggestion, type PieceReplyBubble } from '../components/FlatChessBoard'
import { useMultiplayerGame } from '../hooks/useMultiplayerGame'
import { requestPieceCouncil } from '../lib/pieceCouncilClient'
import type { ClientGameState, PlayerColor } from '../shared/protocol'

function statusLine({
  connected,
  myColor,
  state,
}: {
  connected: boolean
  myColor: PlayerColor | null
  state: ClientGameState | null
}) {
  if (!connected) return { tone: 'warn' as const, text: 'Connecting...' }
  if (!state) return { tone: 'info' as const, text: 'Joining room...' }
  if (state.status.kind === 'waiting') return { tone: 'info' as const, text: 'Waiting for opponent' }
  if (state.status.kind === 'checkmate') {
    return {
      tone: 'done' as const,
      text: state.status.winner === myColor ? 'Checkmate. You win.' : 'Checkmate. You lost.',
    }
  }
  if (state.status.kind === 'stalemate') return { tone: 'done' as const, text: 'Stalemate. Draw.' }
  if (state.status.kind === 'draw') return { tone: 'done' as const, text: 'Draw.' }

  const opponentColor = myColor === 'white' ? 'black' : 'white'
  const opponentConnected = opponentColor === 'white' ? state.hostConnected : state.guestConnected
  if (!opponentConnected) return { tone: 'warn' as const, text: 'Opponent disconnected' }

  const check = state.status.inCheck ? ' Check.' : ''
  return state.turn === myColor
    ? { tone: 'your-turn' as const, text: `Your move.${check}` }
    : { tone: 'wait' as const, text: `Opponent thinking.${check}` }
}

function toSuggestion(move: Move): PieceMoveSuggestion {
  return {
    from: move.from,
    promotion: move.promotion,
    san: move.san,
    to: move.to,
  }
}

function RoomModal({ onClose, url }: { onClose: () => void; url: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="room-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="room-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="room-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="room-modal-heading">
          <div>
            <p className="eyebrow">Room link</p>
            <h2 id="room-modal-title">Invite player two</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="room-link-row">
          <Link2 size={16} />
          <input readOnly value={url} aria-label="Room link" onFocus={(event) => event.currentTarget.select()} />
          <button type="button" onClick={copy}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            <span>{copied ? 'Copied' : 'Copy link'}</span>
          </button>
        </div>
      </section>
    </div>
  )
}

export function MultiplayerGame() {
  const { gameId = '' } = useParams<{ gameId: string }>()
  const { connected, error, makeMove, myColor, state } = useMultiplayerGame(gameId)

  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [isCouncilThinking, setCouncilThinking] = useState(false)
  const [boardReplies, setBoardReplies] = useState<PieceReplyBubble[]>([])
  const [previewMove, setPreviewMove] = useState<PieceMoveSuggestion | null>(null)
  const [councilNote, setCouncilNote] = useState<string | null>(null)
  const [isRoomOpen, setRoomOpen] = useState(false)

  const chess = useMemo(() => {
    const next = new Chess()
    if (state) next.load(state.fen)
    return next
  }, [state])

  const isGameOver =
    state?.status.kind === 'checkmate' || state?.status.kind === 'stalemate' || state?.status.kind === 'draw'
  const isMyTurn = !!state && !!myColor && state.status.kind === 'in_progress' && state.turn === myColor
  const boardDisabled = !connected || !!error || !isMyTurn || isGameOver
  const councilDisabled = boardDisabled || isCouncilThinking

  const legalMoves = useMemo(() => {
    if (!selectedSquare || boardDisabled) return []
    return chess.moves({ square: selectedSquare, verbose: true })
  }, [boardDisabled, chess, selectedSquare])

  const lastMove = useMemo(
    () => (state?.lastMove ? { from: state.lastMove.from as Square, to: state.lastMove.to as Square } : null),
    [state],
  )

  const captured = useMemo(() => (state ? captureSummary(state.history) : { w: [], b: [] }), [state])
  const status = statusLine({ connected, myColor, state })
  const orientation = myColor ?? 'white'
  const topSide: Color = orientation === 'white' ? 'b' : 'w'
  const bottomSide: Color = orientation === 'white' ? 'w' : 'b'
  const shareUrl = typeof window === 'undefined' ? '' : window.location.href

  const lastHistoryLength = useRef(0)
  useEffect(() => {
    const length = state?.history.length ?? 0
    if (length === lastHistoryLength.current) return

    lastHistoryLength.current = length
    setBoardReplies([])
    setPreviewMove(null)
    setCouncilNote(null)
    setSelectedSquare(null)
  }, [state?.history.length])

  const handleSquareSelect = useCallback(
    async (square: Square) => {
      if (boardDisabled) return
      const piece = chess.get(square)
      const myColorCode = myColor === 'white' ? 'w' : 'b'

      if (selectedSquare) {
        const target = legalMoves.find((move) => move.to === square)
        if (target) {
          setSelectedSquare(null)
          setMoveError(null)
          setPreviewMove(null)

          const ack = await makeMove(selectedSquare, square, target.promotion ?? 'q')
          if (ack.ok) {
            setBoardReplies([])
            setCouncilNote(null)
          } else {
            setMoveError(ack.error)
          }
          return
        }
      }

      if (piece && piece.color === myColorCode) {
        setPreviewMove(null)
        setSelectedSquare(square)
        return
      }

      setSelectedSquare(null)
    },
    [boardDisabled, chess, legalMoves, makeMove, myColor, selectedSquare],
  )

  const previewSuggestion = useCallback((suggestion: PieceMoveSuggestion) => {
    setSelectedSquare(null)
    setPreviewMove(suggestion)
  }, [])

  const approveSuggestion = useCallback(
    async (suggestion: PieceMoveSuggestion) => {
      if (councilDisabled) return

      setBoardReplies([])
      setPreviewMove(null)
      setMoveError(null)

      const ack = await makeMove(suggestion.from, suggestion.to, suggestion.promotion ?? ('q' as PieceSymbol))
      if (ack.ok) {
        setCouncilNote(null)
      } else {
        setMoveError(ack.error)
      }
    },
    [councilDisabled, makeMove],
  )

  const sendMessage = useCallback(async () => {
    const trimmed = draft.trim()
    if (!trimmed || councilDisabled) return

    setDraft('')
    setCouncilThinking(true)
    setBoardReplies([])
    setPreviewMove(null)
    setCouncilNote(null)

    try {
      const result = await requestPieceCouncil(chess, trimmed, 3)
      const sourceLabel = result.source === 'gemini' ? 'Gemini counsel' : 'local counsel'

      if (result.terminal) {
        setCouncilNote(result.terminal)
        return
      }

      if (result.replies.length === 0) {
        setCouncilNote('Council has no legal reply from this position.')
        return
      }

      const replies = result.replies.map((reply, index) => ({
        avatar: reply.avatar,
        content: reply.content,
        id: Date.now() + index,
        sender: reply.sender,
        suggestion: toSuggestion(reply.move),
        square: reply.from,
        subtitle: `${reply.subtitle} - ${sourceLabel}`,
      }))

      setBoardReplies(replies)
      setPreviewMove(toSuggestion(result.replies[0].move))
    } catch (err) {
      setCouncilNote((err as Error).message)
    } finally {
      setCouncilThinking(false)
    }
  }, [chess, councilDisabled, draft])

  return (
    <main className="app-shell">
      <div className="workspace-layout">
        <aside className="council-room" aria-label="Council room">
          <div className="council-room-heading">
            <div>
              <p className="eyebrow">
                <Link to="/" className="lobby-link">
                  <Home size={12} /> Lobby
                </Link>{' '}
                / Multiplayer
              </p>
            </div>
            <div className="room-heading-actions">
              <button type="button" className="room-button" onClick={() => setRoomOpen(true)}>
                <Link2 size={13} />
                Room
              </button>
              <span className="council-live">Live</span>
              {isCouncilThinking && <LoaderCircle className="send-spinner" size={16} />}
              {!connected && <WifiOff size={16} />}
            </div>
          </div>

          <div className="council-room-feed" aria-live="polite">
            <article className={`council-event system ${status.tone}`}>
              <span className="council-avatar system">R</span>
              <div className="council-bubble">
                <div className="council-line-meta">
                  <strong>Room {gameId}</strong>
                  <span>{myColor ? myColor : 'joining'}</span>
                </div>
                <p>{status.text}</p>
              </div>
            </article>

            {state?.status.kind === 'waiting' && (
              <article className="council-event system pending">
                <span className="council-avatar system">L</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>Invite link</strong>
                    <span>ready</span>
                  </div>
                  <p>Open Room to copy the link. The next player joins as black.</p>
                </div>
              </article>
            )}

            {isCouncilThinking && (
              <article className="council-event system pending">
                <span className="council-avatar system">C</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>Council</strong>
                    <span>thinking</span>
                  </div>
                  <p>Reading the live board and preparing piece replies.</p>
                </div>
              </article>
            )}

            {boardReplies.length > 0 && !isCouncilThinking && (
              <article className="council-event piece done">
                <span className="council-avatar piece">♙</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>Piece replies</strong>
                    <span>board</span>
                  </div>
                  <p>Suggestions are attached to their pieces. Approve a bubble to play it.</p>
                </div>
              </article>
            )}

            {councilNote && (
              <article className="council-event system blocked">
                <span className="council-avatar system">!</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>Council note</strong>
                    <span>info</span>
                  </div>
                  <p>{councilNote}</p>
                </div>
              </article>
            )}

            {(error || moveError) && (
              <article className="council-event system blocked">
                <span className="council-avatar system">!</span>
                <div className="council-bubble">
                  <div className="council-line-meta">
                    <strong>Room error</strong>
                    <span>flagged</span>
                  </div>
                  <p>{error || moveError}</p>
                </div>
              </article>
            )}
          </div>

          <div className={`composer council-composer ${isCouncilThinking ? 'thinking' : ''}`}>
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
                  isGameOver
                    ? 'Game is over.'
                    : !isMyTurn
                      ? "Wait for opponent's move..."
                      : 'Command your pieces as king...'
                }
                disabled={councilDisabled}
              />
              <div className="composer-status room-status" role="status" aria-live="polite">
                {isCouncilThinking && <LoaderCircle className="send-spinner" size={14} />}
                <span>{status.text}</span>
              </div>
              <button
                type="button"
                onClick={sendMessage}
                aria-label="Send message"
                disabled={councilDisabled || !draft.trim()}
              >
                {isCouncilThinking ? <LoaderCircle className="send-spinner" size={18} /> : <CornerDownLeft size={18} />}
              </button>
            </div>
          </div>
        </aside>

        <section className="board-workspace" aria-label="Multiplayer chess workspace">
          <CapturedRow side={topSide} pieces={captured[topSide]} />

          <div className="scene-shell">
            <FlatChessBoard
              disabled={boardDisabled}
              game={chess}
              selectedSquare={selectedSquare}
              legalTargets={legalMoves.map((move) => move.to)}
              lastMove={lastMove}
              orientation={orientation}
              previewMove={isMyTurn ? previewMove : null}
              replyBubbles={isMyTurn ? boardReplies : []}
              onApproveSuggestion={approveSuggestion}
              onPreviewSuggestion={previewSuggestion}
              onSquareSelect={handleSquareSelect}
            />
          </div>

          <CapturedRow side={bottomSide} pieces={captured[bottomSide]} />

          <footer className="move-strip" aria-label="Move history">
            {!state || state.history.length === 0 ? (
              <span>No moves yet</span>
            ) : (
              state.history.slice(-12).map((move, index) => (
                <span key={`${move.from}-${move.to}-${index}`}>{move.san}</span>
              ))
            )}
          </footer>
        </section>
      </div>

      {isRoomOpen && <RoomModal url={shareUrl} onClose={() => setRoomOpen(false)} />}
    </main>
  )
}
