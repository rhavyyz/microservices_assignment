/** Aceita apenas caminhos internos como destino pós-login (evita open redirect). */
export function safeRedirectPath(from: unknown, fallback = '/perfil'): string {
  if (typeof from !== 'string') return fallback;
  if (!from.startsWith('/') || from.startsWith('//') || from.includes('\\')) return fallback;
  if (from === '/entrar' || from === '/cadastro') return fallback;
  return from;
}
