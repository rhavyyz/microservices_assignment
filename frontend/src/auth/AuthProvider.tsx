import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Role } from '../api/schemas';
import { useServices } from '../services/ServicesContext';
import { AuthContext, type AuthContextValue, type Session } from './AuthContext';

const EXPIRED_NOTICE = 'Sua sessão expirou. Entre novamente.';
const MAX_TIMER_MS = 2_147_483_647; // limite do setTimeout

/**
 * Estado de autenticação. O Access Token fica somente em memória (no SessionBridge): uma atualização completa da
 * página exige novo login. Nada é gravado em localStorage, sessionStorage ou cookies (ADR-006).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { usersApi, session: bridge } = useServices();
  const [session, setSession] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const endSession = useCallback(
    (message: string | null) => {
      clearTimer();
      bridge.setToken(null);
      setSession(null);
      setNotice(message);
    },
    [bridge, clearTimer],
  );

  // 401 em requisição autenticada = sessão inválida/expirada. Idempotente: vários 401 seguidos não geram laço.
  useEffect(() => {
    bridge.setUnauthorizedHandler(() => endSession(EXPIRED_NOTICE));
    return () => bridge.setUnauthorizedHandler(null);
  }, [bridge, endSession]);

  useEffect(() => clearTimer, [clearTimer]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await usersApi.login({ email, password });
      bridge.setToken(result.accessToken);
      const ttl = Math.min(result.expiresIn * 1000, MAX_TIMER_MS);
      clearTimer();
      timer.current = setTimeout(() => endSession(EXPIRED_NOTICE), ttl);
      setNotice(null);
      setSession({ user: result.user, expiresAt: Date.now() + ttl });
    },
    [usersApi, bridge, clearTimer, endSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isAuthenticated: session !== null,
      notice,
      clearNotice: () => setNotice(null),
      login,
      logout: () => endSession(null),
      updateUserName: (name) => setSession((s) => (s ? { ...s, user: { ...s.user, name } } : s)),
      hasRole: (role: Role) => session?.user.roles.includes(role) ?? false,
    }),
    [session, notice, login, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
