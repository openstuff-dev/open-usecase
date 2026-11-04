import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Catalogue, TeamExport, UseCaseDetail } from '@open-usecase/contracts';
import { personActor, teamAccess } from '../auth.js';
import { withScope, type Pool } from '../db.js';
import { notFound } from '../errors.js';
import { loadCatalogue, loadUseCase } from '../service/catalogue.js';
import { verifyManually } from '../service/reports.js';
import { exportTeam, importTeam } from '../service/transfer.js';

const teamParam = z.object({ team: z.string().max(63) });
const useCaseParams = z.object({ team: z.string().max(63), id: z.string() });
const scenarioParams = z.object({
  team: z.string().max(63),
  id: z.string(),
  number: z.coerce.number().int().positive(),
});

function uuid(id: string): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw notFound('That use case');
  return parsed.data;
}

/** The catalogue, one use case in full, a person's manual check, and taking the data elsewhere. */
export function registerCatalogueRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/api/t/:team/catalogue', async (request): Promise<Catalogue> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team);
    return withScope(pool, { teamId }, loadCatalogue);
  });

  app.get('/api/t/:team/usecases/:id', async (request): Promise<UseCaseDetail> => {
    const { team, id } = useCaseParams.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team);
    return withScope(pool, { teamId }, (db) => loadUseCase(db, uuid(id)));
  });

  // Only a person can say they checked: teamAccess refuses every token.
  app.post('/api/t/:team/usecases/:id/scenarios/:number/verify', async (request, reply) => {
    const { team, id, number } = scenarioParams.parse(request.params);
    const { note } = z
      .object({ note: z.string().trim().min(1, 'Say what you checked.').max(5000) })
      .parse(request.body);
    const access = await teamAccess(pool, request, team);
    await withScope(pool, { teamId: access.teamId }, async (db) => {
      await verifyManually(db, await personActor(db, access), {
        useCaseId: uuid(id),
        scenario: number,
        note,
      });
    });
    return reply.code(201).send({ ok: true });
  });

  app.get('/api/t/:team/export', async (request, reply): Promise<TeamExport> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    void reply.header('Content-Disposition', `attachment; filename="openusecase-${team}.json"`);
    return withScope(pool, { teamId }, (db) => exportTeam(db, teamId));
  });

  app.post('/api/t/:team/import', { bodyLimit: 100 * 1024 * 1024 }, async (request, reply) => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const counts = await withScope(pool, { teamId }, (db) =>
      importTeam(db, teamId, request.body as TeamExport),
    );
    return reply.code(201).send(counts);
  });
}
