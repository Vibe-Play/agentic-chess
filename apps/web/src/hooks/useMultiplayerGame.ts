import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { ClientGameState, PlayerColor } from '../shared/protocol'

type JoinAck = { ok: true; color: PlayerColor; playerId: string } | { ok: false; error: string }
type CreateAck = { ok: true; gameId: string; playerId: string; color: PlayerColor } | { ok: false; error: string }
type MoveAck = { ok: true } | { ok: false; error: string }

export type Multiplayer = {
  connected: boolean
  error: string | null
  makeMove: (from: string, to: string, promotion?: string) => Promise<MoveAck>
  myColor: PlayerColor | null
  state: ClientGameState | null
}

const playerKey = (gameId: string) => `agentic-chess:player:${gameId}`

let sharedSocket: Socket | null = null

function getSocket(): Socket {
  if (sharedSocket) return sharedSocket
  sharedSocket = io({ path: '/socket.io', autoConnect: true })
  return sharedSocket
}

export function useMultiplayerGame(gameId: string): Multiplayer {
  const [state, setState] = useState<ClientGameState | null>(null)
  const [myColor, setMyColor] = useState<PlayerColor | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const socketRef = useRef<Socket | null>(null)

  useEffect(() => {
    const socket = getSocket()
    socketRef.current = socket

    const handleConnect = () => {
      setConnected(true)
      const stored = localStorage.getItem(playerKey(gameId)) ?? undefined
      socket.emit('game:join', { gameId, playerId: stored }, (ack: JoinAck) => {
        if (!ack.ok) {
          setError(ack.error)
          return
        }
        setError(null)
        setMyColor(ack.color)
        localStorage.setItem(playerKey(gameId), ack.playerId)
      })
    }
    const handleDisconnect = () => setConnected(false)
    const handleState = (nextState: ClientGameState) => setState(nextState)

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on('game:state', handleState)

    if (socket.connected) handleConnect()

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off('game:state', handleState)
    }
  }, [gameId])

  const makeMove = (from: string, to: string, promotion?: string) =>
    new Promise<MoveAck>((resolve) => {
      const socket = socketRef.current
      if (!socket) {
        resolve({ ok: false, error: 'No socket' })
        return
      }
      socket.emit('move:make', { from, to, promotion }, (ack: MoveAck) => resolve(ack))
    })

  return { connected, error, makeMove, myColor, state }
}

export function createGame(): Promise<{ color: PlayerColor; gameId: string; playerId: string }> {
  return new Promise((resolve, reject) => {
    const socket = getSocket()
    const run = () => {
      socket.emit('game:create', {}, (ack: CreateAck) => {
        if (!ack.ok) {
          reject(new Error(ack.error))
          return
        }
        localStorage.setItem(playerKey(ack.gameId), ack.playerId)
        resolve({ color: ack.color, gameId: ack.gameId, playerId: ack.playerId })
      })
    }
    if (socket.connected) run()
    else socket.once('connect', run)
  })
}
