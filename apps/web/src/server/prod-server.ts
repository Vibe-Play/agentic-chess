import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as IOServer } from 'socket.io'
import { attachGameServer } from './game-server'

const PORT = Number(process.env.PORT ?? 5173)
const DIST = fileURLToPath(new URL('../../dist/', import.meta.url))
const COUNCIL_TARGET = process.env.COUNCIL_TARGET ?? 'http://localhost:8787'

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

async function tryFile(path: string): Promise<{ body: Buffer; mime: string } | null> {
  try {
    const fileStat = await stat(path)
    if (!fileStat.isFile()) return null
    const body = await readFile(path)
    return { body, mime: MIME[extname(path)] ?? 'application/octet-stream' }
  } catch {
    return null
  }
}

async function proxyCouncil(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', COUNCIL_TARGET).toString()
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const init: RequestInit = {
      method: req.method,
      headers: { ...(req.headers as Record<string, string>), host: new URL(COUNCIL_TARGET).host },
    }
    if (chunks.length > 0) init.body = Buffer.concat(chunks)
    const upstream = await fetch(url, init)
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
    res.end(Buffer.from(await upstream.arrayBuffer()))
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`Council proxy error: ${(error as Error).message}`)
  }
}

const httpServer = createServer(async (req, res) => {
  const url = req.url ?? '/'
  if (url.startsWith('/socket.io')) return
  if (url.startsWith('/api/')) return proxyCouncil(req, res)

  const safe = normalize(url.split('?')[0]).replace(/^\/+/, '')
  const direct = await tryFile(join(DIST, safe))
  if (direct) {
    res.writeHead(200, { 'content-type': direct.mime })
    res.end(direct.body)
    return
  }

  const index = await tryFile(join(DIST, 'index.html'))
  if (index) {
    res.writeHead(200, { 'content-type': index.mime })
    res.end(index.body)
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found. Did you run `npm run build`?')
})

const io = new IOServer(httpServer, { path: '/socket.io', cors: { origin: '*' } })
attachGameServer(io)

httpServer.listen(PORT, () => {
  console.log(`[agentic-chess/web] listening on http://localhost:${PORT}`)
  console.log(`[agentic-chess/web] /api -> ${COUNCIL_TARGET}`)
})
