import { type Chess, type Color, type PieceSymbol, type Square } from 'chess.js'

type FlatChessBoardProps = {
  disabled?: boolean
  game: Chess
  selectedSquare: Square | null
  legalTargets: Square[]
  lastMove: { from: Square; to: Square } | null
  orientation?: BoardOrientation
  previewMove: PieceMoveSuggestion | null
  replyBubbles: PieceReplyBubble[]
  onApproveSuggestion: (suggestion: PieceMoveSuggestion) => void
  onPreviewSuggestion: (suggestion: PieceMoveSuggestion) => void
  onSquareSelect: (square: Square) => void
}

export type PieceMoveSuggestion = {
  from: Square
  promotion?: PieceSymbol
  san: string
  to: Square
}

export type PieceReplyBubble = {
  avatar?: string
  content: string
  id: number
  sender: string
  suggestion: PieceMoveSuggestion
  square: Square
  subtitle?: string
}

type BoardOrientation = 'white' | 'black'

const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'] as const

const pieceGlyphs: Record<Color, Record<PieceSymbol, string>> = {
  w: {
    p: '♟',
    n: '♞',
    b: '♝',
    r: '♜',
    q: '♛',
    k: '♚',
  },
  b: {
    p: '♟',
    n: '♞',
    b: '♝',
    r: '♜',
    q: '♛',
    k: '♚',
  },
}

function toSquare(file: (typeof files)[number], rank: (typeof ranks)[number]): Square {
  return `${file}${rank}` as Square
}

function squarePosition(square: Square, orientation: BoardOrientation = 'white') {
  const file = square[0] as (typeof files)[number]
  const rank = square[1] as (typeof ranks)[number]
  const fileIndex = Math.max(0, files.indexOf(file))
  const rankIndex = Math.max(0, ranks.indexOf(rank))

  return {
    file: files[fileIndex],
    fileIndex: orientation === 'white' ? fileIndex : 7 - fileIndex,
    rank: ranks[rankIndex],
    rankIndex: orientation === 'white' ? rankIndex : 7 - rankIndex,
  }
}

function bubbleDirection(square: Square, replyIndex: number, orientation: BoardOrientation) {
  const { fileIndex, rankIndex } = squarePosition(square, orientation)
  const pointsRight = fileIndex <= 1 || (fileIndex < 6 && replyIndex % 2 === 1)
  const pointsLeft = fileIndex >= 6 || !pointsRight

  if (rankIndex >= 5) return pointsLeft ? 'up-left' : 'up-right'
  if (rankIndex <= 2) return pointsLeft ? 'down-left' : 'down-right'
  return fileIndex < 4 ? 'side-right' : 'side-left'
}

function isSameSuggestion(left: PieceMoveSuggestion | null, right: PieceMoveSuggestion) {
  return left?.from === right.from && left.to === right.to && left.san === right.san
}

export function FlatChessBoard({
  disabled = false,
  game,
  selectedSquare,
  legalTargets,
  lastMove,
  orientation = 'white',
  previewMove,
  replyBubbles,
  onApproveSuggestion,
  onPreviewSuggestion,
  onSquareSelect,
}: FlatChessBoardProps) {
  const legalSet = new Set(legalTargets)
  const displayFiles = orientation === 'white' ? files : [...files].reverse()
  const displayRanks = orientation === 'white' ? ranks : [...ranks].reverse()

  return (
    <div className="flat-board-shell" aria-label="2D chessboard">
      <div className={`flat-board ${disabled ? 'disabled' : ''}`}>
        {displayRanks.map((rank, rankIndex) =>
          displayFiles.map((file, fileIndex) => {
            const square = toSquare(file, rank)
            const piece = game.get(square)
            const isLight = (rankIndex + fileIndex) % 2 === 0
            const isSelected = selectedSquare === square
            const isLegal = legalSet.has(square)
            const isLastMove = lastMove?.from === square || lastMove?.to === square
            const isPreviewFrom = previewMove?.from === square
            const isPreviewTo = previewMove?.to === square

            return (
              <button
                type="button"
                className={[
                  'flat-square',
                  isLight ? 'light' : 'dark',
                  isSelected ? 'selected' : '',
                  isLegal ? 'legal' : '',
                  isLastMove ? 'last-move' : '',
                  isPreviewFrom ? 'preview-from' : '',
                  isPreviewTo ? 'preview-to' : '',
                  `file-${file}`,
                  `rank-${rank}`,
                ].join(' ')}
                key={square}
                onClick={() => onSquareSelect(square)}
                disabled={disabled}
                aria-label={square}
              >
                {fileIndex === 0 && <span className="rank-label">{rank}</span>}
                {rankIndex === 7 && <span className="file-label">{file}</span>}
                {isPreviewTo && <span className="preview-label">{previewMove.san}</span>}
                {piece && (
                  <span className={`flat-piece ${piece.color === 'w' ? 'white' : 'black'}`}>
                    {pieceGlyphs[piece.color][piece.type]}
                  </span>
                )}
              </button>
            )
          }),
        )}
        {replyBubbles.length > 0 && (
          <div className="piece-reply-layer" aria-live="polite">
            {replyBubbles.map((reply, index) => {
              const position = squarePosition(reply.square, orientation)

              return (
                <div
                  className={`piece-reply-anchor ${bubbleDirection(reply.square, index, orientation)} file-${position.file} rank-${position.rank}`}
                  key={reply.id}
                  style={{
                    left: `${position.fileIndex * 12.5}%`,
                    top: `${position.rankIndex * 12.5}%`,
                  }}
                >
                  <article
                    className="piece-reply-bubble"
                    onPointerEnter={() => onPreviewSuggestion(reply.suggestion)}
                    title={`${reply.sender}: ${reply.suggestion.san}. ${reply.content}`}
                  >
                    <div className="piece-reply-meta">
                      {reply.avatar && <span className="piece-reply-avatar">{reply.avatar}</span>}
                      <strong>{reply.sender}</strong>
                    </div>
                    <div className="suggestion-actions" aria-label={`${reply.sender} suggests ${reply.suggestion.san}`}>
                      <button
                        type="button"
                        className={`move-token ${isSameSuggestion(previewMove, reply.suggestion) ? 'active' : ''}`}
                        onClick={() => onPreviewSuggestion(reply.suggestion)}
                      >
                        {reply.suggestion.san}
                      </button>
                      <button
                        type="button"
                        className="approve-move"
                        onClick={() => onApproveSuggestion(reply.suggestion)}
                        aria-label={`Approve ${reply.suggestion.san} from ${reply.sender}`}
                      >
                        Run
                      </button>
                    </div>
                  </article>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
