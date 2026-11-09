import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Role } from '@open-usecase/contracts';
import { actorFromToken, bearer, registerAuth, requirePerson, teamAccess } from './auth.js';
import { type Config, policyFrom } from './config.js';
import { withScope, type Pool } from './db.js';
import { registerErrorHandler } from './errors.js';
import { registerIdempotency } from './idempotency.js';
import { createMcpServer } from './mcp.js';
import {
  announceGroups,
  loadVault,
  publishVersionOnStart,
  registerIntegrationRoutes,
} from '@openstuff-dev/server';
import { registerActorRoutes } from './routes/actors.js';
import { registerGlossaryRoutes } from './routes/glossary.js';
import { registerCatalogueRoutes } from './routes/catalogue.js';
import { registerReviewRoutes } from './routes/review.js';
import { integrationOffers } from './integrations.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerV1Routes } from './routes/v1.js';
import { GlossaryReader } from './service/glossary.js';

/** Every role: anyone in a team may read their own OpenAnnounce token. */
const ALL_ROLES: readonly Role[] = ['admin', 'member'];

/** One read per MCP request, because the instructions depend on it. */
async function hasGlossary(pool: Pool, teamId: string): Promise<boolean> {
  return withScope(pool, { teamId }, async (db) =>
    Boolean((await db.query('SELECT 1 FROM openpurpose_links')).rowCount),
  );
}

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
  registerCatalogueRoutes(app, pool);
  registerActorRoutes(app, pool);
  registerSettingsRoutes(app, pool);
  registerV1Routes(app, pool, config);
  const vault = await loadVault(pool, {
    secret: config.secretKey,
    envName: 'OPENUSECASE_SECRET_KEY',
    log: app.log,
  });
  // Server-wide connections from the shared package, the same routes every OpenStuff app has.
  const offers = integrationOffers(config);
  registerIntegrationRoutes(app, {
    db: pool,
    vault: () => Promise.resolve(vault),
    policy: policyFrom(config),
    origin: new URL(config.publicUrl).origin,
    appName: 'OpenUsecase',
    offers,
    isServerAdmin: (request) => requirePerson(request).isServerAdmin,
    // OpenAnnounce sees the account's id and the groups for the team in `?team=`, never a name
    // or an email. Someone not in that team gets 404 from teamAccess; tokens get nothing.
    announceUser: async (request) => {
      if (!request.account || request.usedToken) return null;
      const { team } = request.query as { team?: unknown };
      if (typeof team !== 'string' || !team) return { sub: request.account.id, groups: [] };
      const access = await teamAccess(pool, request, team, ALL_ROLES);
      return { sub: request.account.id, groups: announceGroups(team, access.role) };
    },
  });
  publishVersionOnStart(app, {
    db: pool,
    vault: () => Promise.resolve(vault),
    offer: offers[0],
    policy: policyFrom(config),
    appName: 'OpenUsecase',
    version: config.appVersion,
  });
  const glossary = new GlossaryReader(policyFrom(config), vault);
  registerGlossaryRoutes(app, pool, glossary, vault, policyFrom(config));

  // MCP over stateless Streamable HTTP: a new server per request, as in OpenPurpose.
  app.post('/mcp', async (request, reply) => {
    const actor = await actorFromToken(pool, bearer(request.headers.authorization));
    if (!actor) return refuseMcp(reply, 401, 'That token is missing, unknown or revoked.');
    if (actor.kind !== 'agent') return refuseMcp(reply, 403, 'Only agents can use MCP.');
    const linked = await hasGlossary(pool, actor.teamId);
    const server = createMcpServer(pool, actor, config.appVersion, glossary, linked);
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
