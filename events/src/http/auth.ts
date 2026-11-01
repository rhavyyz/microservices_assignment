// Access Token: the user service signs JWTs with RS256 and publishes its public keys at
// /.well-known/jwks.json. Every request is verified here, locally (no call per request), and the
// identity comes only from the verified `sub` claim; the gateway's X-User-Id header is not trusted.
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import type { Actor } from '../domain/model.ts';
import { AppError, unauthorized } from '../errors.ts';

export type Jwk = { kty: string; kid?: string; n?: string; e?: string; use?: string; alg?: string };
/** The JWK type createPublicKey accepts (its name differs between @types/node versions). */
type CryptoJwk = Extract<Parameters<typeof createPublicKey>[0], { format: 'jwk' }>['key'];

export type VerifierOptions = {
  issuer: string;
  /** Downloads the current key set (JWKS `keys`). */
  fetchKeys: () => Promise<Jwk[]>;
  cacheSeconds: number;
  /** Accepted clock difference with the issuer, in seconds. */
  leewaySeconds?: number;
  now?: () => number;
  /** Told when the key set cannot be downloaded (the cached keys keep being used meanwhile). */
  onKeysError?: (error: Error) => void;
};

// At most one key download per 10s, whatever happens: forged kids cannot flood the user service and an
// unreachable user service is not hammered.
const MIN_REFRESH_MS = 10_000;

const decodeJson = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not a JSON object');
  return value as Record<string, unknown>;
};

export function createTokenVerifier(opts: VerifierOptions) {
  const now = opts.now ?? Date.now;
  const leeway = opts.leewaySeconds ?? 30;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;
  let attemptedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    inflight ??= opts.fetchKeys().then((jwks) => {
      keys = new Map(jwks
        .filter((k) => k.kty === 'RSA' && k.kid && (k.use === undefined || k.use === 'sig'))
        .map((k) => [k.kid!, createPublicKey({ key: k as CryptoJwk, format: 'jwk' })]));
      fetchedAt = now();
    }).finally(() => { inflight = null; });
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (inflight) await inflight.catch(() => {}); // a download is running: use its result
    const t = now();
    const stale = t - fetchedAt > opts.cacheSeconds * 1000;
    if ((stale || !keys.has(kid)) && t - attemptedAt > MIN_REFRESH_MS) {
      attemptedAt = t;
      try {
        await refresh();
      } catch (e) {
        opts.onKeysError?.(e as Error);
        if (!keys.has(kid)) throw new AppError(503, 'AUTH_UNAVAILABLE', 'access tokens cannot be verified right now');
      }
    }
    return keys.get(kid);
  }

  /** Returns the actor of a valid token; any problem is the same 401 (details are not leaked). */
  return async function verifyToken(token: string): Promise<Actor> {
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized('malformed token');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = decodeJson(parts[0]);
      claims = decodeJson(parts[1]);
    } catch {
      throw unauthorized('malformed token');
    }
    // Only RS256 is accepted: this rejects `alg: none` and HMAC tricks with the public key.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw unauthorized('unsupported token');

    const key = await keyFor(header.kid);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    if (!key || !verify('RSA-SHA256', signed, key, Buffer.from(parts[2], 'base64url'))) {
      throw unauthorized('invalid token signature');
    }

    const nowSeconds = now() / 1000;
    if (claims.iss !== opts.issuer) throw unauthorized('unexpected token issuer');
    if (typeof claims.exp !== 'number' || claims.exp + leeway < nowSeconds) throw unauthorized('token expired');
    if (typeof claims.nbf === 'number' && claims.nbf - leeway > nowSeconds) throw unauthorized('token not valid yet');
    if (typeof claims.sub !== 'string' || claims.sub === '') throw unauthorized('token without subject');

    const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === 'string') : [];
    return { userId: claims.sub, roles };
  };
}

export type TokenVerifier = ReturnType<typeof createTokenVerifier>;

/** Downloads a JWKS document (`{"keys": [...]}`). */
export async function fetchJwks(url: string, fetchFn: typeof fetch = fetch): Promise<Jwk[]> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(3000) });
  if (res.status !== 200) throw new Error(`JWKS answered ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error('JWKS without keys');
  return body.keys as Jwk[];
}

/** Reads `Authorization: Bearer <token>`; null when the header is absent. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw unauthorized('the Authorization header must be "Bearer <token>"');
  return match[1];
}
