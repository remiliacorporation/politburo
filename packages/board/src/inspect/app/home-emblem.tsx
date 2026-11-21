import emblem from '../../../../../.github/assets/politburo-emblem.png'
import { Link } from './nav.tsx'

export function HomeEmblem({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/" className="home-emblem" onNavigate={onNavigate}>
      <img src={emblem} alt="Politburo home" width={32} height={32} />
    </Link>
  )
}
