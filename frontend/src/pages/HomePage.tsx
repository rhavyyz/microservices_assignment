import { Link } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { usePageTitle } from '../components/usePageTitle';

export function HomePage() {
  usePageTitle('Início');
  const { session, hasRole } = useAuth();
  return (
    <section>
      <h1>Início</h1>
      <p className="lead">Olá, {session?.user.name}. O que você quer fazer?</p>
      <ul className="tiles">
        <li>
          <Link className="tile" to="/eventos">
            <strong>Explorar eventos</strong>
            <span>Veja a programação e escolha atividades.</span>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/inscricoes">
            <strong>Acompanhar inscrições</strong>
            <span>Situação, lista de espera, ofertas e cancelamento.</span>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/notificacoes">
            <strong>Notificações</strong>
            <span>Avisos sobre inscrições e pagamentos.</span>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/certificados">
            <strong>Meus certificados</strong>
            <span>Baixe o certificado dos eventos que você concluiu.</span>
          </Link>
        </li>
        <li>
          <Link className="tile" to="/perfil">
            <strong>Dados da conta</strong>
            <span>Consulte e atualize o seu nome.</span>
          </Link>
        </li>
        {hasRole('ORGANIZER') ? (
          <li>
            <Link className="tile" to="/organizador">
              <strong>Gerenciar meus eventos</strong>
              <span>Criar, publicar, montar a programação e fazer check-in.</span>
            </Link>
          </li>
        ) : null}
        {hasRole('ORGANIZER') ? (
          <li>
            <Link className="tile" to="/usuarios">
              <strong>Buscar usuários</strong>
              <span>Área do organizador.</span>
            </Link>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
