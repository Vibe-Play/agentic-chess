import type { Color, Move, PieceSymbol } from 'chess.js'

const capturedGlyphs: Record<PieceSymbol, string> = {
  p: '♟',
  n: '♞',
  b: '♝',
  r: '♜',
  q: '♛',
  k: '♚',
}

const pieceValues: Record<PieceSymbol, number> = { p: 1, n: 3, r: 5, b: 3, q: 9, k: 0 }
const order: PieceSymbol[] = ['q', 'r', 'b', 'n', 'p']

export function captureSummary(history: Move[]): Record<Color, PieceSymbol[]> {
  const result: Record<Color, PieceSymbol[]> = { w: [], b: [] }

  for (const move of history) {
    if (!move.captured) continue
    const victimColor: Color = move.color === 'w' ? 'b' : 'w'
    result[victimColor].push(move.captured)
  }

  const rank = (piece: PieceSymbol) => order.indexOf(piece)
  result.w.sort((a, b) => rank(a) - rank(b))
  result.b.sort((a, b) => rank(a) - rank(b))

  return result
}

export function CapturedRow({ side, pieces }: { side: Color; pieces: PieceSymbol[] }) {
  const score = pieces.reduce((sum, piece) => sum + pieceValues[piece], 0)

  return (
    <div className={`captured-row ${side === 'w' ? 'white' : 'black'}`}>
      {pieces.map((piece, index) => (
        <span key={`${piece}-${index}`} className="captured-piece">
          {capturedGlyphs[piece]}
        </span>
      ))}
      {score > 0 && <span className="captured-score">+{score}</span>}
    </div>
  )
}
