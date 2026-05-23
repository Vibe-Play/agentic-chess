import { type Chess, type Color, type PieceSymbol, type Square } from 'chess.js'

type FlatChessBoardProps = {
  game: Chess
  selectedSquare: Square | null
  legalTargets: Square[]
  lastMove: { from: Square; to: Square } | null
  onSquareSelect: (square: Square) => void
}

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

export function FlatChessBoard({
  game,
  selectedSquare,
  legalTargets,
  lastMove,
  onSquareSelect,
}: FlatChessBoardProps) {
  const legalSet = new Set(legalTargets)

  return (
    <div className="flat-board-shell" aria-label="2D chessboard">
      <div className="flat-board">
        {ranks.map((rank, rankIndex) =>
          files.map((file, fileIndex) => {
            const square = toSquare(file, rank)
            const piece = game.get(square)
            const isLight = (rankIndex + fileIndex) % 2 === 0
            const isSelected = selectedSquare === square
            const isLegal = legalSet.has(square)
            const isLastMove = lastMove?.from === square || lastMove?.to === square

            return (
              <button
                type="button"
                className={[
                  'flat-square',
                  isLight ? 'light' : 'dark',
                  isSelected ? 'selected' : '',
                  isLegal ? 'legal' : '',
                  isLastMove ? 'last-move' : '',
                ].join(' ')}
                key={square}
                onClick={() => onSquareSelect(square)}
                aria-label={square}
              >
                {fileIndex === 0 && <span className="rank-label">{rank}</span>}
                {rankIndex === 7 && <span className="file-label">{file}</span>}
                {piece && (
                  <span className={`flat-piece ${piece.color === 'w' ? 'white' : 'black'}`}>
                    {pieceGlyphs[piece.color][piece.type]}
                  </span>
                )}
              </button>
            )
          }),
        )}
      </div>
    </div>
  )
}
