// Identity comes only from the gateway: it verifies the JWT and sends X-User-Id (the `sub`, a UUID) and
// X-User-Roles (comma separated). This service never sees or checks a token and trusts those headers, which
// is safe only because the service is reachable through the gateway alone (network isolation), as in the
// other services.
import type { IncomingHttpHeaders } from 'node:http';
import type { Actor } from '../domain/model.ts';
import { unauthorized } from '../errors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const single = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(',') : v);

/**
 * The caller, or null without an X-User-Id header (anonymous, fine for public reads). A header that is
 * present but is not a UUID is a 401, never anonymous. Roles are trimmed and upper-cased.
 */
export function actorFromHeaders(headers: IncomingHttpHeaders): Actor | null {
  const raw = single(headers['x-user-id'])?.trim();
  if (!raw) return null;
  if (!UUID.test(raw)) throw unauthorized('X-User-Id must be a UUID');
  const roles = (single(headers['x-user-roles']) ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter(Boolean);
  return { userId: raw, roles };
}
