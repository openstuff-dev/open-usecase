import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Actor } from '../auth.js';
import type { Config } from '../config.js';
import { withScope, type Pool } from '../db.js';
import { HttpError } from '../errors.js';
import { checkPullRequest, uploadReport } from '../service/reports.js';

const reportBody = z.object({
  remote: z.string().min(1).max(500),
  branch: z.string().min(1).max(255),
  suite: z.string().trim().min(1).max(100).default('default'),
  commit: z.string().min(1).max(100),
  junit: z.string().min(1),
});

const checkBody = z.object({
  remote: z.string().min(1).max(500),
  useCases: z.array(z.string().max(20)).max(100).default([]),
  exemption: z.string().max(1000).optional(),
  junit: z.string().optional(),
});

/** These routes are for CI tokens, and a CI token can do nothing else. */
function requireCi(request: FastifyRequest): Actor {
  const actor = request.tokenActor;
  if (!actor) throw new HttpError(401, 'Send a CI token as "Authorization: Bearer uc_…".');
  if (actor.kind !== 'ci') throw new HttpError(403, 'This needs a CI token. Add one in Settings.');
  return actor;
}

export function registerV1Routes(app: FastifyInstance, pool: Pool, config: Config): void {
  const options = { bodyLimit: config.reportMaxBytes };

  app.post('/api/v1/reports', options, async (request) => {
    const actor = requireCi(request);
    const body = reportBody.parse(request.body);
    return withScope(pool, { teamId: actor.teamId }, (db) => uploadReport(db, actor, body));
  });

  app.post('/api/v1/check', options, async (request) => {
    const actor = requireCi(request);
    const body = checkBody.parse(request.body);
    return withScope(pool, { teamId: actor.teamId }, (db) => checkPullRequest(db, body));
  });
}
