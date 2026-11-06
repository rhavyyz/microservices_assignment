// Exception tracking at the HTTP edge: every error becomes an application/problem+json body (RFC 9457)
// with a stable `code` and the request's `traceId`, the same format as the user service. Only expected
// errors explain themselves; anything else is a generic 500 whose details stay in the log.
import { STATUS_CODES } from 'node:http';
import { AppError } from '../errors.ts';

export type FieldIssue = { field: string; message: string };

export type Problem = {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  code: string;
  traceId: string;
  errors?: FieldIssue[];
};

type ValidationItem = { instancePath?: string; message?: string; params?: Record<string, unknown> };
type FrameworkError = { statusCode?: number; validation?: ValidationItem[]; validationContext?: string; message?: string };

/** Where an ajv error points: the property path, or the missing/unexpected property. */
function fieldOf(v: ValidationItem, context: string | undefined): string {
  const path = (v.instancePath ?? '').split('/').filter(Boolean).join('.');
  const extra = v.params?.missingProperty ?? v.params?.additionalProperty;
  const field = [path, typeof extra === 'string' ? extra : ''].filter(Boolean).join('.');
  return field || context || 'request';
}

/** Maps any thrown value to a problem; `unexpected` tells the caller to log it as a failure. */
export function toProblem(err: unknown, traceId: string): { problem: Problem; unexpected: boolean } {
  const make = (status: number, code: string, detail: string, errors?: FieldIssue[]): Problem => ({
    type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status, detail, code, traceId, ...(errors ? { errors } : {}),
  });

  if (err instanceof AppError) return { problem: make(err.status, err.code, err.message), unexpected: false };

  const e = (typeof err === 'object' && err !== null ? err : {}) as FrameworkError;
  if (Array.isArray(e.validation)) {
    const errors = e.validation.map((v) => ({
      field: fieldOf(v, e.validationContext),
      message: v.params?.additionalProperty ? 'is not allowed' : (v.message ?? 'is invalid'),
    }));
    return { problem: make(400, 'VALIDATION_ERROR', 'the request is invalid', errors), unexpected: false };
  }
  // Framework 4xx (malformed JSON, unsupported media type, body too large...): their messages are safe.
  if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
    return { problem: make(e.statusCode, 'BAD_REQUEST', e.message ?? 'bad request'), unexpected: false };
  }
  return { problem: make(500, 'INTERNAL_ERROR', 'unexpected error; quote the traceId when reporting it'), unexpected: true };
}

const SAFE_TRACE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Keeps the gateway's X-Trace-Id when it is well formed (it then ties all logs together), else a new one. */
export function traceIdFrom(header: unknown, generate: () => string): string {
  return typeof header === 'string' && SAFE_TRACE_ID.test(header) ? header : generate();
}
