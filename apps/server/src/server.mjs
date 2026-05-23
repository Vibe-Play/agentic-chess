import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'
import { buildPieceCouncilContext, piecePersonas } from '@agentic-chess/chess-council'

const serverDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(serverDir, '../../..')

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
const geminiModel = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'
const maxBodyBytes = 64_000

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

function safeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function normalizeMaxReplies(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 3
  return Math.min(6, Math.max(1, Math.round(parsed)))
}

function buildCandidateRoster(replies) {
  return replies.map((reply) => {
    const persona = piecePersonas[reply.piece]
    return {
      archetype: reply.archetype,
      from: reply.from,
      legalMove: {
        san: reply.move.san,
        to: reply.move.to,
      },
      masterPrompt: persona.masterPrompt,
      piece: reply.piece,
      relevance: reply.relevance,
      sender: reply.sender,
      subtitle: reply.subtitle,
      voice: persona.voice,
    }
  })
}

function extractTextFromGemini(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => (typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n') ?? ''
  )
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

function mergeGeminiReplies(rawReplies, legalReplies) {
  if (!Array.isArray(rawReplies)) return []

  const byIdentity = new Map()
  for (const reply of legalReplies) {
    byIdentity.set(`${reply.from}:${reply.move.san}`, reply)
    byIdentity.set(`${reply.from}:${reply.move.to}`, reply)
  }

  return rawReplies
    .map((raw) => {
      const from = safeText(raw?.from, 2)
      const san = safeText(raw?.san ?? raw?.move?.san, 16)
      const to = safeText(raw?.to ?? raw?.move?.to, 2)
      const legal = byIdentity.get(`${from}:${san}`) ?? byIdentity.get(`${from}:${to}`)
      if (!legal) return null

      const content = safeText(raw?.content, 420)
      const sender = safeText(raw?.sender, 64)
      const subtitle = safeText(raw?.subtitle, 96)

      return {
        ...legal,
        content: content || legal.content,
        sender: sender || legal.sender,
        subtitle: subtitle || legal.subtitle,
      }
    })
    .filter(Boolean)
}

async function askGemini(context) {
  if (context.replies.length === 0) {
    return {
      source: 'fallback',
      replies: [],
    }
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return {
      source: 'fallback',
      warning: 'GEMINI_API_KEY is not set; using deterministic legal-move council.',
      replies: context.replies,
    }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  const systemInstruction = [
    'You write compact Agentic Chess board bubbles that appear over the responding pieces.',
    'The user is the king and gives strategic commands. Never speak as the king.',
    'Reply only as the provided legal candidate pieces.',
    'Do not invent moves, squares, captures, checks, or tactics outside the candidate list.',
    'Each piece should sound like its archetype and answer in one compact board-bubble sentence.',
    'Return strict JSON with shape {"replies":[{"from":"e2","san":"e4","sender":"Pawn e2","subtitle":"Frontline scout","content":"..."}]}.',
  ].join(' ')

  try {
    const geminiResponse = await fetch(endpoint, {
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify(
                  {
                    fen: context.fen,
                    kingCommand: context.command,
                    legalCandidatePieces: buildCandidateRoster(context.replies),
                    sideToMove: context.sideToMove,
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.35,
        },
        system_instruction: {
          parts: [{ text: systemInstruction }],
        },
      }),
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      method: 'POST',
      signal: controller.signal,
    })

    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text()
      throw new Error(`Gemini ${geminiResponse.status}: ${errorBody.slice(0, 240)}`)
    }

    const data = await geminiResponse.json()
    const parsed = parseJsonObject(extractTextFromGemini(data))
    const replies = mergeGeminiReplies(parsed?.replies, context.replies)

    if (replies.length === 0) {
      return {
        source: 'fallback',
        warning: 'Gemini returned no valid legal piece replies; using deterministic council.',
        replies: context.replies,
      }
    }

    return { source: 'gemini', replies }
  } finally {
    clearTimeout(timeout)
  }
}

async function handlePieceCouncil(request, response) {
  const body = await readJsonBody(request)
  const command = safeText(body.command, 1_200)

  if (!command) {
    sendJson(response, 400, { error: 'command is required' })
    return
  }

  if (typeof body.fen !== 'string') {
    sendJson(response, 400, { error: 'fen is required' })
    return
  }

  let game
  try {
    game = new Chess(body.fen)
  } catch {
    sendJson(response, 400, { error: 'fen is not a valid chess position' })
    return
  }

  const context = buildPieceCouncilContext(game, command, normalizeMaxReplies(body.maxReplies))

  if (context.terminal) {
    sendJson(response, 200, {
      replies: [],
      source: 'fallback',
      terminal: context.terminal,
    })
    return
  }

  try {
    sendJson(response, 200, await askGemini(context))
  } catch (error) {
    console.error(error)
    sendJson(response, 200, {
      replies: context.replies,
      source: 'fallback',
      warning: 'Gemini request failed; using deterministic legal-move council.',
    })
  }
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
    await handlePieceCouncil(request, response)
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
