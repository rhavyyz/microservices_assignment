import { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';

// Access log: Fastify's 'request completed' record is the equivalent of the platform access line
// (`<METHOD> <path> status=<N> duration=<d> user=<id or -> trace_id=<id>`): req.method, req.url (path only),
// res.statusCode, responseTime, traceId and userId (only when the gateway sent a valid X-User-Id).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The request path without the query string: query values can be personal or free text. */
export function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/** Only method and path: no query string, no headers, no body. */
export function serializeReq(req: { method?: string; url?: string; raw?: { url?: string } }) {
  return { method: req.method, url: pathOf(req.url ?? req.raw?.url) };
}

/** One 'request completed' line per request; no 'incoming request' line; /healthcheck is not logged at all. */
class AccessLogController extends LogController {
  override isLogDisabled(req: { url?: string; raw?: { url?: string } }): boolean {
    return pathOf(req.url ?? req.raw?.url) === '/healthcheck';
  }

  override incomingRequest(): void {}

  // Fastify's own record has no `req`: add it (method and path, through the serializer) so the line stands alone.
  override requestCompleted(error: Error | null | undefined, request: any, reply: any): void {
    if (this.isLogDisabled(request)) return;
    if (error) reply.log.error({ req: request, res: reply, err: error, responseTime: reply.elapsedTime }, 'request errored');
    else reply.log.info({ req: request, res: reply, responseTime: reply.elapsedTime }, 'request completed');
  }
}

/** Logger options of the server: `logger` as given (true by default) plus the path-only req serializer. */
export function accessLogOptions(logger: FastifyServerOptions['logger'] = true) {
  const base = logger === true ? {} : logger;
  return {
    logger: base === false || base === undefined
      ? false
      : { ...base, serializers: { ...(base as { serializers?: object }).serializers, req: serializeReq } },
    logController: new AccessLogController({ requestIdLogLabel: 'traceId' }),
  } as Pick<FastifyServerOptions, 'logger' | 'logController'>;
}

/** Binds `userId` to the request-scoped logger when X-User-Id is a valid UUID (never the raw header value). */
export function bindUserToLog(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const v = req.headers['x-user-id'];
    const id = (Array.isArray(v) ? v[0] : v)?.trim();
    if (!id || !UUID.test(id)) return;
    req.log = req.log.child({ userId: id });
    reply.log = req.log; // 'request completed' is written by reply.log
  });
}
