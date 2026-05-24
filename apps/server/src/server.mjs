import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handlePieceCouncilPayload } from './council-core.mjs'

const serverDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(serverDir, '../../..')
const maxBodyBytes = 64_000

function loadEnvFile(path) {
  if (!existsSync(path)) return

  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator).trim()
    const rawValue = trimmed.slice(separator + 1).trim()
    if (!key || process.env[key] !== undefined) continue

    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadEnvFile(resolve(repoRoot, '.env'))
loadEnvFile(resolve(repoRoot, 'apps/server/.env'))

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '127.0.0.1'

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

function sendJson(response, statusCode, payload) {
  if (response.writableEnded) return

  response.writeHead(statusCode, {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(statusCode === 204 ? undefined : JSON.stringify(payload))
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    let rejected = false

    request.on('data', (chunk) => {
      if (rejected) return
      body += chunk
      if (body.length > maxBodyBytes) {
        rejected = true
        reject(new HttpError(413, 'Request body is too large.'))
      }
    })

    request.on('end', () => {
      if (rejected) return
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'))
      }
    })

    request.on('error', reject)
  })
}

async function routeRequest(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)

  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {})
    return
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    sendJson(response, 200, { ok: true })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/piece-council') {
    const body = await readJsonBody(request)
    const result = await handlePieceCouncilPayload(body, process.env)
    sendJson(response, result.status, result.payload)
    return
  }

  sendJson(response, 404, { error: 'not found' })
}

createServer((request, response) => {
  routeRequest(request, response).catch((error) => {
    const statusCode = error instanceof HttpError ? error.statusCode : 500
    if (statusCode === 500) console.error(error)
    sendJson(response, statusCode, {
      error: error instanceof Error ? error.message : 'Unexpected server error.',
    })
  })
}).listen(port, host, () => {
  console.log(`agentic-chess server listening on http://${host}:${port}`)
})
