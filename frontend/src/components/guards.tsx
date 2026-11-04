import { Navigate, Outlet, useLocation } from 'react-router';
import type { Role } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { safeRedirectPath } from '../auth/redirect';
import { ForbiddenPage } from '../pages/ForbiddenPage';

/**
 * Rotas protegidas NO CLIENTE servem apenas à experiência de navegação. A autorização efetiva é do backend:
 * esconder uma página ou um botão nunca substitui a recusa (401/403) feita pelo servidor.
 */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) {
    return (
      <Navigate to="/entrar" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  return <Outlet />;
}

/** Visitante: quem já tem sessão é levado ao destino original (ou ao perfil). Sem laço: /entrar não exige sessão. */
export function GuestOnly() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  if (isAuthenticated) {
    const from = (location.state as { from?: unknown } | null)?.from;
    return <Navigate to={safeRedirectPath(from)} replace />;
  }
  return <Outlet />;
}

/** Mostra "acesso negado" (sem redirecionar) para quem não tem o papel. É só UX; o servidor também recusa. */
export function RequireRole({ role }: { role: Role }) {
  const { hasRole } = useAuth();
  return hasRole(role) ? <Outlet /> : <ForbiddenPage />;
}

export function HomeRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? '/inicio' : '/eventos'} replace />;
}
