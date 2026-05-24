import { handlePieceCouncilPayload } from '../../server/src/council-core.mjs'

const corsHeaders = {
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Origin': '*',
}

function json(payload, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload), {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
    status,
  })
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return json({}, 204)
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/api/piece-council') {
      const body = await readJson(request)
      if (!body) return json({ error: 'Request body must be valid JSON.' }, 400)

      const result = await handlePieceCouncilPayload(body, env)
      return json(result.payload, result.status)
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request)
    }

    return json({ error: 'not found' }, 404)
  },
}
