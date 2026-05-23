# agentic-chess

Agentic Chess is a monorepo for a playable chess board with an LLM-backed piece council.

## Structure

- `apps/web`: Vite React chess UI.
- `apps/server`: Node HTTP API for piece-council orchestration and Gemini calls.
- `packages/chess-council`: Shared legal-move ranking and piece persona primitives.

## Setup

```bash
npm install
```

Create a local `.env` for the server from `.env.example` and set `GEMINI_API_KEY`.
Keep that key server-only. The browser talks to `/api/piece-council` through the Vite dev proxy.

## Development

Run the backend in one terminal:

```bash
npm run dev:server
```

Run the web app in another terminal:

```bash
npm run dev:web
```

The web app runs on Vite and proxies `/api` to `http://localhost:8787`.

## Build

```bash
npm run build
```
