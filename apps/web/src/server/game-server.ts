import { Chess } from 'chess.js'
import { customAlphabet } from 'nanoid'
import type { Server as IOServer, Socket } from 'socket.io'
import type { ClientGameState, PlayerColor } from '../shared/protocol'

const newGameId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6)

type Seat = {
  color: PlayerColor
  playerId: string
  socketId: string | null
}

type GameRecord = {
  chess: Chess
  createdAt: number
  guest: Seat | null
  host: Seat | null
  id: string
  lastActivity: number
}

const games = new Map<string, GameRecord>()

function colorCode(color: PlayerColor): 'b' | 'w' {
  return color === 'white' ? 'w' : 'b'
}

function turnColor(chess: Chess): PlayerColor {
  return chess.turn() === 'w' ? 'white' : 'black'
}

function buildState(game: GameRecord): ClientGameState {
  const chess = game.chess
  const history = chess.history({ verbose: true })
  const last = history[history.length - 1]
  let status: ClientGameState['status']

  if (!game.guest) {
    status = { kind: 'waiting' }
  } else if (chess.isCheckmate()) {
    status = { kind: 'checkmate', winner: chess.turn() === 'w' ? 'black' : 'white' }
  } else if (chess.isStalemate()) {
    status = { kind: 'stalemate' }
  } else if (chess.isDraw()) {
    status = { kind: 'draw' }
  } else {
    status = { kind: 'in_progress', inCheck: chess.inCheck() }
  }

  return {
    id: game.id,
    fen: chess.fen(),
    pgn: chess.pgn(),
    turn: turnColor(chess),
    history,
    status,
    hostConnected: !!game.host?.socketId,
    guestConnected: !!game.guest?.socketId,
    lastMove: last ? { from: last.from, san: last.san, to: last.to } : null,
  }
}

function broadcast(io: IOServer, game: GameRecord) {
  io.to(`game:${game.id}`).emit('game:state', buildState(game))
}

function findGameByPlayer(playerId: string): { game: GameRecord; seat: Seat } | null {
  for (const game of games.values()) {
    if (game.host?.playerId === playerId) return { game, seat: game.host }
    if (game.guest?.playerId === playerId) return { game, seat: game.guest }
  }
  return null
}

function attachSeat(socket: Socket, game: GameRecord, seat: Seat) {
  seat.socketId = socket.id
  socket.data.playerId = seat.playerId
  socket.data.gameId = game.id
  socket.join(`game:${game.id}`)
  game.lastActivity = Date.now()
}

export function attachGameServer(io: IOServer) {
  io.on('connection', (socket) => {
    socket.on(
      'game:create',
      (
        _payload,
        ack: (response: { ok: true; color: PlayerColor; gameId: string; playerId: string } | { ok: false; error: string }) => void,
      ) => {
        try {
          const gameId = newGameId()
          const playerId = crypto.randomUUID()
          const game: GameRecord = {
            id: gameId,
            chess: new Chess(),
            host: { color: 'white', playerId, socketId: socket.id },
            guest: null,
            createdAt: Date.now(),
            lastActivity: Date.now(),
          }
          games.set(gameId, game)
          socket.data.playerId = playerId
          socket.data.gameId = gameId
          socket.join(`game:${gameId}`)
          ack({ ok: true, color: 'white', gameId, playerId })
          broadcast(io, game)
        } catch (error) {
          ack({ ok: false, error: (error as Error).message })
        }
      },
    )

    socket.on(
      'game:join',
      (
        payload: { gameId: string; playerId?: string },
        ack: (response: { ok: true; color: PlayerColor; playerId: string } | { ok: false; error: string }) => void,
      ) => {
        const game = games.get(payload.gameId)
        if (!game) {
          ack({ ok: false, error: 'Game not found' })
          return
        }

        if (payload.playerId) {
          if (game.host?.playerId === payload.playerId) {
            attachSeat(socket, game, game.host)
            ack({ ok: true, color: game.host.color, playerId: game.host.playerId })
            broadcast(io, game)
            return
          }
          if (game.guest?.playerId === payload.playerId) {
            attachSeat(socket, game, game.guest)
            ack({ ok: true, color: game.guest.color, playerId: game.guest.playerId })
            broadcast(io, game)
            return
          }
        }

        if (!game.guest) {
          const playerId = crypto.randomUUID()
          const seat: Seat = { color: 'black', playerId, socketId: socket.id }
          game.guest = seat
          attachSeat(socket, game, seat)
          ack({ ok: true, color: 'black', playerId })
          broadcast(io, game)
          return
        }

        ack({ ok: false, error: 'Game is full' })
      },
    )

    socket.on(
      'move:make',
      (
        payload: { from: string; promotion?: string; to: string },
        ack: (response: { ok: true } | { ok: false; error: string }) => void,
      ) => {
        const gameId = socket.data.gameId as string | undefined
        const playerId = socket.data.playerId as string | undefined
        if (!gameId || !playerId) {
          ack({ ok: false, error: 'Not in a game' })
          return
        }

        const game = games.get(gameId)
        if (!game) {
          ack({ ok: false, error: 'Game not found' })
          return
        }

        const seat =
          game.host?.playerId === playerId
            ? game.host
            : game.guest?.playerId === playerId
              ? game.guest
              : null
        if (!seat) {
          ack({ ok: false, error: 'Not a player in this game' })
          return
        }
        if (!game.guest) {
          ack({ ok: false, error: 'Waiting for opponent' })
          return
        }
        if (game.chess.isGameOver()) {
          ack({ ok: false, error: 'Game is over' })
          return
        }
        if (colorCode(seat.color) !== game.chess.turn()) {
          ack({ ok: false, error: 'Not your turn' })
          return
        }

        let move
        try {
          move = game.chess.move({ from: payload.from, to: payload.to, promotion: payload.promotion ?? 'q' })
        } catch {
          move = null
        }
        if (!move) {
          ack({ ok: false, error: 'Illegal move' })
          return
        }

        game.lastActivity = Date.now()
        ack({ ok: true })
        broadcast(io, game)
      },
    )

    socket.on('disconnect', () => {
      const playerId = socket.data.playerId as string | undefined
      if (!playerId) return
      const found = findGameByPlayer(playerId)
      if (!found) return
      if (found.seat.socketId === socket.id) {
        found.seat.socketId = null
        broadcast(io, found.game)
      }
    })
  })

  const interval = setInterval(() => {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000
    for (const [id, game] of games) {
      if (game.lastActivity < cutoff) games.delete(id)
    }
  }, 10 * 60 * 1000)
  if (typeof interval === 'object' && interval && 'unref' in interval) {
    ;(interval as { unref: () => void }).unref()
  }
}
