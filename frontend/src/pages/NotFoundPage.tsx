import { Link } from 'react-router';
import { usePageTitle } from '../components/usePageTitle';

export function NotFoundPage() {
  usePageTitle('Página não encontrada');
  return (
    <section className="card">
      <h1>Página não encontrada</h1>
      <p>O endereço acessado não existe.</p>
      <p>
        <Link to="/">Ir para o início</Link>
      </p>
    </section>
  );
}
