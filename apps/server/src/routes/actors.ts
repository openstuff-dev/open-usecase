import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { personActor, teamAccess } from '../auth.js';
import { withScope, type Pool } from '../db.js';
import { notFound } from '../errors.js';
import { addToken } from '../service/setup.js';

const params = z.object({ team: z.string().max(63), id: z.uuid().catch('') });
const permissions = z.object({
  review: z.enum(['human_approval', 'agent_review', 'auto_approve']).optional(),
  canReview: z.boolean().optional(),
});

/**
 * Tokens and permissions. Only a team's admins, signed in as people, can reach these:
 * `teamAccess` refuses every token first, so an agent can't manage anything, not even itself.
 */
export function registerActorRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/api/t/:team/actors/:id/tokens', async (request, reply) => {
    const { team, id } = params.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const created = await withScope(pool, { teamId }, async (db) => {
      const actor = await db.query(`SELECT 1 FROM actors WHERE id = $1 AND kind <> 'human'`, [
        id || null,
      ]);
      if (!actor.rowCount) throw notFound('That agent');
      return addToken(db, teamId, id);
    });
    return reply.code(201).send(created);
  });

  app.delete('/api/t/:team/tokens/:id', async (request) => {
    const { team, id } = params.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, async (db) => {
      const { rowCount } = await db.query(
        'UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id || null],
      );
      if (!rowCount) throw notFound('That token');
    });
    return { ok: true };
  });

  app.patch('/api/t/:team/actors/:id', async (request) => {
    const { team, id } = params.parse(request.params);
    const input = permissions.parse(request.body);
    const access = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId: access.teamId }, async (db) => {
      const by = await personActor(db, access);
      const { rowCount } = await db.query(
        `UPDATE actors SET review = coalesce($2, review), can_review = coalesce($3, can_review),
                permissions_by = $4, permissions_at = now()
          WHERE id = $1 AND kind = 'agent'`,
        [id || null, input.review ?? null, input.canReview ?? null, by.id],
      );
      if (!rowCount) throw notFound('That agent');
    });
    return { ok: true };
  });
}
