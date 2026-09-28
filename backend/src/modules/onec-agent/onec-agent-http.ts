import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { json } from 'express';
import { ONEC_AGENT_API_PATH } from './onec-runtime-config.service';

/** Global-prefix exclusion for the agent API (it lives outside /api/v1). */
export const ONEC_AGENT_PREFIX_EXCLUDE = { path: `${ONEC_AGENT_API_PATH}/{*path}`, method: RequestMethod.ALL };

/**
 * Must run before the global body parsers. On the dedicated agent listener
 * only the agent API is served; everything else is 404 there.
 */
export function mountOnecAgentHttp(app: INestApplication, options: { enabled: boolean; agentPort: number }): void {
  const agentPath = `/${ONEC_AGENT_API_PATH}/`;
  app.use(
    (
      req: { socket?: { localPort?: number }; path: string },
      res: { status(code: number): { json(body: unknown): void } },
      next: () => void,
    ) => {
      if (options.enabled && req.socket?.localPort === options.agentPort && !req.path.startsWith(agentPath)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
        return;
      }
      next();
    },
  );
  app.use(`/${ONEC_AGENT_API_PATH}`, rejectNonJsonBody, json({ limit: '2mb', verify: captureRawBody }), bodyParserErrorHandler);
}

/** Keeps the exact request bytes: `PUT result` must be stored/compared byte for byte. */
function captureRawBody(req: IncomingMessage, _res: ServerResponse, buffer: Buffer): void {
  (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
}

/**
 * Only JSON bodies are accepted on the agent API. Any other content type is
 * refused before the body is read, so the global 50 MiB urlencoded/json
 * parsers never consume an unauthenticated agent-path body. The one exception
 * is `POST etl/batches` with application/x-ndjson: it is streamed to the spool
 * by the ETL controller after the guard (no body parser matches that type).
 */
function rejectNonJsonBody(
  req: { method: string; path: string; headers: Record<string, string | string[] | undefined>; requestId?: string },
  res: { status(code: number): { json(body: unknown): void } },
  next: () => void,
): void {
  const length = req.headers['content-length'];
  const hasBody = req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  // ETL batches are streamed (gzip NDJSON, up to 100 MB) by the controller itself; no parser reads them.
  if (req.method === 'POST' && req.path === '/etl/batches' && type === 'application/x-ndjson') {
    next();
    return;
  }
  if (hasBody && type !== 'application/json') {
    res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Only application/json is accepted', requestId: req.requestId ?? 'req_unknown' } });
    return;
  }
  next();
}

/**
 * The agent reacts to status codes (spec §2.5): an oversized or malformed
 * body must be 413/400, not the generic 500 of the global exception filter.
 */
function bodyParserErrorHandler(
  error: { type?: string; status?: number } | undefined,
  req: { requestId?: string },
  res: { status(code: number): { json(body: unknown): void } },
  next: (error?: unknown) => void,
): void {
  if (!error) {
    next();
    return;
  }
  const requestId = req.requestId ?? 'req_unknown';
  if (error.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large', requestId } });
    return;
  }
  if (error.type === 'entity.parse.failed' || error.status === 400) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON body', requestId } });
    return;
  }
  next(error);
}

/**
 * Second listener for the same Express app; Traefik routes only the mTLS
 * agent host here. Timeouts cover a 120 s long poll and a 300 s upload.
 */
export function listenOnecAgent(app: INestApplication, port: number, host?: string): Server {
  const server = createServer(app.getHttpAdapter().getInstance());
  server.requestTimeout = 330_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 65_000;
  if (host) server.listen(port, host);
  else server.listen(port);
  return server;
}
