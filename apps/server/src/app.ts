import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { actorFromToken, bearer, registerAuth } from './auth.js';
import { type Config } from './config.js';
import type { Pool } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { createMcpServer } from './mcp.js';
import { registerActorRoutes } from './routes/actors.js';
import { registerReviewRoutes } from './routes/review.js';

const VERSION = '0.0.0';

const refuseMcp = (reply: FastifyReply, status: number, message: string) =>
  reply
    .code(status)
    .header('WWW-Authenticate', 'Bearer')
    .send({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });

export async function buildApp(config: Config, pool: Pool): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel }, trustProxy: config.trustProxy });
  registerErrorHandler(app);
  await app.register(fastifyCookie);

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  registerAuth(app, pool, config);
  registerIdempotency(app);
  registerReviewRoutes(app, pool);
  registerActorRoutes(app, pool);

  // MCP over stateless Streamable HTTP: a new server per request, as in OpenPurpose.
  app.post('/mcp', async (request, reply) => {
    const actor = await actorFromToken(pool, bearer(request.headers.authorization));
    if (!actor) return refuseMcp(reply, 401, 'That token is missing, unknown or revoked.');
    if (actor.kind !== 'agent') return refuseMcp(reply, 403, 'Only agents can use MCP.');
    const server = createMcpServer(pool, actor, VERSION);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  const methodNotAllowed = (_request: unknown, reply: FastifyReply) =>
    reply
      .code(405)
      .header('Allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  if (config.webDir) await app.register(fastifyStatic, { root: config.webDir });
  // The web app routes in the browser, so other pages get index.html. A missing file stays a 404,
  // or an old tab asking for a deleted chunk would get HTML (org learning).
  app.setNotFoundHandler((request, reply) =>
    !config.webDir || request.url.startsWith('/api/') || /\.\w+$/.test(request.url.split('?')[0] ?? '')
      ? reply.code(404).send({ error: 'Not found' })
      : reply.sendFile('index.html'),
  );

  return app;
}
