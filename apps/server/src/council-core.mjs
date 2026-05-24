import { Chess } from 'chess.js'
import {
  buildManagedPieceCouncilContext,
  buildPieceCouncilContext,
  piecePersonas,
} from '@agentic-chess/chess-council'

const defaultGeminiModel = 'gemini-2.5-flash'

function safeText(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function normalizeMaxReplies(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 3
  return Math.min(6, Math.max(1, Math.round(parsed)))
}

function normalizePromptOverrides(value) {
  if (!value || typeof value !== 'object') return {}

  const overrides = {}
  for (const piece of ['p', 'n', 'b', 'r', 'q', 'k']) {
    const prompt = safeText(value[piece], 6_000)
    if (prompt) overrides[piece] = prompt
  }
  return overrides
}

function buildCandidateRoster(replies, promptOverrides = {}) {
  return replies.map((reply) => {
    const persona = piecePersonas[reply.piece]
    return {
      archetype: reply.archetype,
      from: reply.from,
      legalMove: {
        san: reply.move.san,
        to: reply.move.to,
      },
      masterPrompt: promptOverrides[reply.piece] ?? persona.masterPrompt,
      piece: reply.piece,
      relevance: reply.relevance,
      sender: reply.sender,
      subtitle: reply.subtitle,
      voice: persona.voice,
    }
  })
}

function buildTraceEvent(actor, content, status = 'done') {
  return {
    actor,
    content,
    status,
  }
}

function summarizeCandidateClasses(replies) {
  if (replies.length === 0) return 'No legal council candidates.'
  return replies.map((reply) => `${reply.sender} ${reply.move.san}`).join(', ')
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

function buildLegalMoveRoster(game, promptOverrides = {}) {
  return game.moves({ verbose: true }).map((move) => {
    const piece = game.get(move.from)
    const persona = piece ? piecePersonas[piece.type] : null

    return {
      captures: move.captured ?? null,
      className: persona?.name ?? 'Unknown',
      from: move.from,
      givesCheck: move.san.includes('+') || move.san.includes('#'),
      masterPrompt: piece ? (promptOverrides[piece.type] ?? persona?.masterPrompt ?? null) : null,
      piece: piece?.type ?? null,
      promotion: move.promotion ?? null,
      san: move.san,
      to: move.to,
    }
  })
}

function normalizeManagedSelections(rawSelections) {
  if (!Array.isArray(rawSelections)) return []

  return rawSelections
    .map((raw) => ({
      content: safeText(raw?.content ?? raw?.reason, 320),
      from: safeText(raw?.from, 2),
      relevance: Number(raw?.score ?? raw?.relevance ?? 0),
      san: safeText(raw?.san ?? raw?.move?.san, 16),
      sender: safeText(raw?.sender, 64),
      subtitle: safeText(raw?.subtitle, 96),
      to: safeText(raw?.to ?? raw?.move?.to, 2),
    }))
    .filter((selection) => selection.from || selection.to || selection.san)
}

function normalizeCommand(value) {
  return safeText(value, 1_200).toLowerCase()
}

function normalizeSan(value) {
  return safeText(value, 16).toLowerCase().replace(/0/g, 'o').replace(/[+#?!\s]/g, '')
}

function hasAnyText(value, terms) {
  return terms.some((term) => value.includes(term))
}

function buildCastleQuestion(game, command) {
  const normalized = normalizeCommand(command)
  const asksToCastle = hasAnyText(normalized, ['castle', 'castling', 'o-o', '0-0'])
  const specifiedSide = hasAnyText(normalized, [
    'king side',
    'kingside',
    'short castle',
    'queen side',
    'queenside',
    'long castle',
  ])

  if (!asksToCastle || specifiedSide) return null

  const castleMoves = game
    .moves({ verbose: true })
    .filter((move) => move.piece === 'k' && normalizeSan(move.san).startsWith('o-o'))

  if (castleMoves.length < 2) return null

  return {
    options: castleMoves.map((move) => (move.to[0] === 'g' ? `short castle (${move.san})` : `long castle (${move.san})`)),
    question: 'Both castles are legal. Short castle or long castle?',
  }
}

function geminiConfig(env = {}) {
  return {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL ?? defaultGeminiModel,
  }
}

async function askGeminiDirector(game, command, maxReplies, promptOverrides = {}, env = {}) {
  const { apiKey, model } = geminiConfig(env)
  if (!apiKey) return null

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10_000)
  const replyLimit = Math.min(3, Math.max(1, Number(maxReplies) || 3))

  const systemInstruction = [
    'You are the Agentic Chess strategy director.',
    'The user is the king. Convert the king command into the strongest legal move shortlist.',
    'Choose only moves from the provided legalMoves roster. Never invent SAN, source squares, or destinations.',
    'Honor direct commands first: if the king asks to castle and a castling move is legal, rank that castling move first.',
    'Ask one concise question only when the command is impossible, internally conflicting, or needs the king to choose between incompatible plans.',
    'Return at most maxReplies moves and keep unique piece classes when possible.',
    'Return strict JSON: {"moves":[{"from":"e1","to":"g1","san":"O-O","sender":"Castling","subtitle":"Royal guard","content":"Short castle is ready now.","score":100}],"question":"optional","options":["optional"],"note":"optional"}',
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
                    fen: game.fen(),
                    kingCommand: command,
                    legalMoves: buildLegalMoveRoster(game, promptOverrides),
                    maxReplies: replyLimit,
                    sideToMove: game.turn() === 'w' ? 'White' : 'Black',
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
          temperature: 0.18,
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
      throw new Error(`Gemini director ${geminiResponse.status}: ${errorBody.slice(0, 240)}`)
    }

    const data = await geminiResponse.json()
    const parsed = parseJsonObject(extractTextFromGemini(data))
    const rawMoves = Array.isArray(parsed?.moves) ? parsed.moves : parsed?.priorities

    return {
      note: safeText(parsed?.note, 240),
      options: Array.isArray(parsed?.options) ? parsed.options.map((option) => safeText(option, 120)).filter(Boolean) : [],
      question: safeText(parsed?.question, 220),
      selections: normalizeManagedSelections(rawMoves),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function askGemini(context, promptOverrides = {}, env = {}) {
  if (context.replies.length === 0) {
    return {
      source: 'fallback',
      replies: [],
    }
  }

  const { apiKey, model } = geminiConfig(env)
  if (!apiKey) {
    return {
      source: 'fallback',
      warning: 'GEMINI_API_KEY is not set; using deterministic legal-move council.',
      replies: context.replies,
    }
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12_000)

  const systemInstruction = [
    'You write compact Agentic Chess board bubbles that appear over the responding pieces.',
    'The user is the king and gives strategic commands. Never speak as the king.',
    'Reply only as the provided legal candidate pieces.',
    'Keep the candidate order exactly; the first reply is the move autopilot will make.',
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
                    legalCandidatePieces: buildCandidateRoster(context.replies, promptOverrides),
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

export async function handlePieceCouncilPayload(body, env = {}) {
  const command = safeText(body?.command, 1_200)
  const trace = [buildTraceEvent('Ingress', 'Received council request from the board.')]

  if (!command) {
    return { status: 400, payload: { error: 'command is required' } }
  }

  if (typeof body?.fen !== 'string') {
    return { status: 400, payload: { error: 'fen is required' } }
  }

  let game
  try {
    game = new Chess(body.fen)
    trace.push(buildTraceEvent('Board parser', `FEN accepted. ${game.turn() === 'w' ? 'White' : 'Black'} is to move.`))
  } catch {
    return { status: 400, payload: { error: 'fen is not a valid chess position' } }
  }

  const replyLimit = normalizeMaxReplies(body.maxReplies)
  const promptOverrides = normalizePromptOverrides(body.promptOverrides)
  let context = buildPieceCouncilContext(game, command, replyLimit)
  const castleQuestion = !context.terminal ? buildCastleQuestion(game, command) : null

  if (castleQuestion) {
    return {
      status: 200,
      payload: {
        question: castleQuestion.question,
        questionOptions: castleQuestion.options,
        replies: [],
        source: 'fallback',
        trace: [...trace, buildTraceEvent('Council question', castleQuestion.question, 'pending')],
      },
    }
  }

  if (!context.terminal && env.GEMINI_API_KEY) {
    try {
      const director = await askGeminiDirector(game, command, replyLimit, promptOverrides, env)
      if (director?.question) {
        return {
          status: 200,
          payload: {
            question: director.question,
            questionOptions: director.options,
            replies: [],
            source: 'gemini',
            trace: [...trace, buildTraceEvent('Strategy director', director.question, 'pending')],
          },
        }
      }

      if (director?.selections?.length) {
        const managedContext = buildManagedPieceCouncilContext(game, command, director.selections, replyLimit)
        if (managedContext.replies.length > 0) {
          context = managedContext
          trace.push(
            buildTraceEvent(
              'Strategy director',
              `Gemini ranked the plan: ${summarizeCandidateClasses(context.replies)}.`,
            ),
          )
        } else {
          trace.push(
            buildTraceEvent('Strategy director', 'Gemini returned no legal ranked moves; local ranking stayed in control.', 'blocked'),
          )
        }
      } else {
        trace.push(buildTraceEvent('Strategy director', 'Gemini returned no ranked moves; local ranking stayed in control.', 'blocked'))
      }
    } catch (error) {
      console.error(error)
      trace.push(
        buildTraceEvent('Strategy director', 'Gemini strategy director missed the call; local ranking stayed in control.', 'blocked'),
      )
    }
  }

  trace.push(
    buildTraceEvent(
      'Move arbiter',
      `Ranked legal piece classes: ${summarizeCandidateClasses(context.replies)}`,
      context.replies.length > 0 ? 'done' : 'blocked',
    ),
  )

  if (context.terminal) {
    return {
      status: 200,
      payload: {
        replies: [],
        source: 'fallback',
        trace: [...trace, buildTraceEvent('Board state', context.terminal, 'blocked')],
        terminal: context.terminal,
      },
    }
  }

  try {
    trace.push(
      buildTraceEvent(
        'LLM router',
        env.GEMINI_API_KEY
          ? `Sending ${context.replies.length} legal class candidates to ${geminiConfig(env).model}.`
          : 'Gemini key missing; deterministic local council will answer.',
        env.GEMINI_API_KEY ? 'done' : 'blocked',
      ),
    )
    const result = await askGemini(context, promptOverrides, env)
    trace.push(
      buildTraceEvent(
        result.source === 'gemini' ? 'Gemini counsel' : 'Local counsel',
        `Returned ${result.replies.length} legal board bubble${result.replies.length === 1 ? '' : 's'}.`,
      ),
    )
    return { status: 200, payload: { ...result, trace } }
  } catch (error) {
    console.error(error)
    return {
      status: 200,
      payload: {
        replies: context.replies,
        source: 'fallback',
        trace: [
          ...trace,
          buildTraceEvent('Gemini counsel', 'Model request failed; falling back to deterministic legal candidates.', 'blocked'),
          buildTraceEvent('Local counsel', `Returned ${context.replies.length} legal board bubbles.`),
        ],
        warning: 'Gemini request failed; using deterministic legal-move council.',
      },
    }
  }
}
