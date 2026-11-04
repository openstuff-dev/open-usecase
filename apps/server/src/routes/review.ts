import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Inbox } from '@open-usecase/contracts';
import { personActor, teamAccess } from '../auth.js';
import { withScope, type Pool } from '../db.js';
import { notFound } from '../errors.js';
import {
  approveUseCase,
  commentById,
  loadInbox,
  requestChanges,
} from '../service/usecases.js';

const teamParams = z.object({ team: z.string().max(63) });
const useCaseParams = z.object({ team: z.string().max(63), id: z.string() });
const commentBody = z.object({
  body: z.string().trim().min(1, 'Write a comment first.').max(10_000),
  scenario: z.number().int().positive().optional(),
});

/** A malformed id can't be a use case, so it reads the same as one that isn't there. */
function useCaseId(id: string): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw notFound('That use case');
  return parsed.data;
}

/** The inbox, and what a person does there: approve, ask for changes, comment. */
export function registerReviewRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/api/t/:team/inbox', async (request): Promise<Inbox> => {
    const { team } = teamParams.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team);
    return withScope(pool, { teamId }, loadInbox);
  });

  app.post('/api/t/:team/usecases/:id/approve', async (request) => {
    const { team, id } = useCaseParams.parse(request.params);
    const access = await teamAccess(pool, request, team);
    return withScope(pool, { teamId: access.teamId }, async (db) =>
      approveUseCase(db, await personActor(db, access), useCaseId(id)),
    );
  });

  app.post('/api/t/:team/usecases/:id/request-changes', async (request) => {
    const { team, id } = useCaseParams.parse(request.params);
    const access = await teamAccess(pool, request, team);
    return withScope(pool, { teamId: access.teamId }, async (db) =>
      requestChanges(db, await personActor(db, access), useCaseId(id)),
    );
  });

  app.post('/api/t/:team/usecases/:id/comments', async (request, reply) => {
    const { team, id } = useCaseParams.parse(request.params);
    const input = commentBody.parse(request.body);
    const access = await teamAccess(pool, request, team);
    const comment = await withScope(pool, { teamId: access.teamId }, async (db) =>
      commentById(db, await personActor(db, access), useCaseId(id), input),
    );
    return reply.code(201).send(comment);
  });
}
