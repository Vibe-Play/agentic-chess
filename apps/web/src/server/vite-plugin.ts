import { Server as IOServer } from 'socket.io'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { attachGameServer } from './game-server'

function attach(httpServer: PreviewServer['httpServer'] | ViteDevServer['httpServer']) {
  if (!httpServer) return
  const io = new IOServer(httpServer, {
    path: '/socket.io',
    cors: { origin: '*' },
  })
  attachGameServer(io)
}

export function gameServerPlugin(): Plugin {
  return {
    name: 'agentic-chess-game-server',
    configureServer(server) {
      attach(server.httpServer)
    },
    configurePreviewServer(server) {
      attach(server.httpServer)
    },
  }
}
