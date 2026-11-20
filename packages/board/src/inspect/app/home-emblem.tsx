import emblem from '../../../../../.github/assets/politburo-emblem.png'
import { Link } from './nav.tsx'

export function HomeEmblem({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link to="/" className="home-emblem" onNavigate={onNavigate}>
      <img src={emblem} alt="" width={24} height={24} />
      <span>Politburo<span className="home-emblem-label"> home</span></span>
    </Link>
  )
}
