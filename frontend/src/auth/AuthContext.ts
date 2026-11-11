import { createContext, useContext } from 'react';
import type { Role, UserSummary } from '../api/schemas';

export interface Session {
  user: UserSummary;
  /** Instante (ms desde a época) em que o token expira. */
  expiresAt: number;
}

export interface AuthContextValue {
  session: Session | null;
  isAuthenticated: boolean;
  /** Aviso a mostrar na tela de login (ex.: sessão expirada). */
  notice: string | null;
  clearNotice: () => void;
  login: (email: string, password: string) => Promise<void>;
  /** Encerra a sessão local (descarta o token da memória). Não existe revogação no servidor. */
  logout: () => void;
  /** Atualiza o nome exibido após editar o perfil. */
  updateUserName: (name: string) => void;
  /** Só para experiência de navegação: quem autoriza de verdade é o backend. */
  hasRole: (role: Role) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>.');
  return ctx;
}
