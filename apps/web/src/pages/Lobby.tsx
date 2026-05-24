import { useState } from 'react'
import { Link2, Swords, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { createGame } from '../hooks/useMultiplayerGame'

export function Lobby() {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onCreate = async () => {
    setCreating(true)
    setError(null)

    try {
      const { gameId } = await createGame()
      navigate(`/game/${gameId}`)
    } catch (err) {
      setError((err as Error).message)
      setCreating(false)
    }
  }

  return (
    <main className="lobby-shell">
      <div className="lobby-card">
        <p className="eyebrow">Agentic chess</p>
        <h1>Pick a mode</h1>

        <button type="button" className="lobby-action primary" onClick={onCreate} disabled={creating}>
          <Link2 size={18} />
          <span>
            <strong>{creating ? 'Creating game...' : 'Create multiplayer game'}</strong>
            <small>Get a shareable room link. You play white.</small>
          </span>
        </button>

        <button type="button" className="lobby-action" onClick={() => navigate('/local')}>
          <Users size={18} />
          <span>
            <strong>Single game</strong>
            <small>Play locally with the piece council.</small>
          </span>
        </button>

        {error && <p className="lobby-error">{error}</p>}

        <p className="lobby-foot">
          <Swords size={12} /> Got a room link? Open it directly.
        </p>
      </div>
    </main>
  )
}
