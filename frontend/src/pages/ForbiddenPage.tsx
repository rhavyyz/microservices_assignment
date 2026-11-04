import { Link } from 'react-router';
import { usePageTitle } from '../components/usePageTitle';

export function ForbiddenPage() {
  usePageTitle('Acesso negado');
  return (
    <section className="card">
      <h1>Acesso negado</h1>
      <p>Você não tem permissão para acessar esta página.</p>
      <p>
        <Link to="/perfil">Voltar ao meu perfil</Link>
      </p>
    </section>
  );
}
