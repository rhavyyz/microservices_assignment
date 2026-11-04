import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';

export function Layout() {
  const { isAuthenticated, hasRole, session, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    void navigate('/entrar', { replace: true });
  }

  return (
    <>
      <a className="skip-link" href="#conteudo">
        Ir para o conteúdo
      </a>
      <header className="app-header">
        <div className="container header-inner">
          <Link to="/" className="brand">
            EventHub
          </Link>
          <nav aria-label="Navegação principal">
            <ul className="nav-list">
              {isAuthenticated ? (
                <>
                  <li>
                    <NavLink to="/perfil">Meu perfil</NavLink>
                  </li>
                  {hasRole('ORGANIZER') ? (
                    <li>
                      <NavLink to="/usuarios">Usuários</NavLink>
                    </li>
                  ) : null}
                  <li className="nav-user" aria-label="Usuário autenticado">
                    {session?.user.name}
                  </li>
                  <li>
                    <button type="button" className="btn btn-link" onClick={handleLogout}>
                      Sair
                    </button>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <NavLink to="/entrar">Entrar</NavLink>
                  </li>
                  <li>
                    <NavLink to="/cadastro">Cadastrar</NavLink>
                  </li>
                </>
              )}
            </ul>
          </nav>
        </div>
      </header>
      <main id="conteudo" className="container main">
        <Outlet />
      </main>
    </>
  );
}
