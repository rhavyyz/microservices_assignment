// Messages this service consumes from the subscription topic (default `subscription-events`).
// Same envelope as every producer (see envelope.ts); the registration.* types are the ones the
// subscription service already publishes for the reports service.

export type SeatCommand = {
  kind: 'reserve' | 'release';
  registrationId: string;
  eventId: string;
  activityId: string;
  userId: string | null;
};

export type ParsedCommand = { messageId: string; type: string; correlationId: string | null; command: SeatCommand | null };
export type ParseResult = { ok: true; value: ParsedCommand } | { ok: false; error: string };

/** What each consumed type asks for; any other type is ignored (command null), never an error. */
const KIND_BY_TYPE: Record<string, SeatCommand['kind']> = {
  'registration.requested': 'reserve',
  'registration.cancelled': 'release',
  'registration.expired': 'release',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(o: Obj, key: string, required: boolean): string | null {
  const v = o[key];
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (required) throw new Error(`${key} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v.trim();
}

export function parseCommand(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (!isObj(json)) return { ok: false, error: 'message must be a JSON object' };

  try {
    const messageId = text(json, 'message_id', true)!;
    const type = text(json, 'type', true)!;
    const version = json.version ?? 1;
    if (version !== 1) throw new Error(`unsupported version ${String(version)}`);
    const correlationId = text(json, 'correlation_id', false);

    const kind = KIND_BY_TYPE[type];
    if (!Object.hasOwn(KIND_BY_TYPE, type)) return { ok: true, value: { messageId, type, correlationId, command: null } };
    if (!isObj(json.data)) throw new Error('data must be an object');

    const command: SeatCommand = {
      kind,
      registrationId: text(json.data, 'registration_id', true)!,
      eventId: text(json.data, 'event_id', true)!,
      activityId: text(json.data, 'activity_id', true)!,
      userId: text(json.data, 'user_id', false),
    };
    return { ok: true, value: { messageId, type, correlationId, command } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
