// Turns validated JSON (dates are ISO strings) into the inputs of the use cases (dates are Date).
import type { ListQuery } from '../services/events.ts';

const DATE_FIELDS = ['starts_at', 'ends_at'] as const;

/** Copy of a validated body with its period fields as Date; absent fields stay absent (partial updates). */
export function withDates<T>(body: unknown): T {
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of DATE_FIELDS) if (typeof out[k] === 'string') out[k] = new Date(out[k] as string);
  return out as T;
}

/** Validated query string (defaults already applied by the schema) -> list filter. */
export function toListQuery(query: unknown): ListQuery {
  const q = query as { q?: string; from?: string; to?: string; limit: number; offset: number };
  const text = q.q?.trim();
  return {
    text: text ? text : undefined,
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    limit: q.limit,
    offset: q.offset,
  };
}
