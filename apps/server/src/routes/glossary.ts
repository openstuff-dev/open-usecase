import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Glossary, OpenPurposeLink } from '@open-usecase/contracts';
import { teamAccess } from '../auth.js';
import type { Vault } from '../crypto.js';
import { withScope, type Pool } from '../db.js';
import type { FetchPolicy } from '../safe-fetch.js';
import { type GlossaryReader, testLink } from '../service/glossary.js';

const teamParam = z.object({ team: z.string().max(63) });

/** The link to OpenPurpose, for a team's admins, and the terms, for everyone who reviews. */
export function registerGlossaryRoutes(
  app: FastifyInstance,
  pool: Pool,
  glossary: GlossaryReader,
  vault: Vault,
  policy: FetchPolicy,
): void {
  app.get('/api/t/:team/openpurpose', async (request): Promise<OpenPurposeLink> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ url: string }>('SELECT url FROM openpurpose_links');
      return { url: rows.at(0)?.url ?? null };
    });
  });

  app.put('/api/t/:team/openpurpose', async (request) => {
    const { team } = teamParam.parse(request.params);
    const body = z
      .object({
        url: z.url().max(500).transform((url) => url.replace(/\/+$/, '')),
        token: z.string().trim().min(1, 'Give it a token.').max(1000),
      })
      .parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    // Outside a transaction: another server's answer shouldn't hold a database connection.
    await testLink(policy, body.url, body.token);
    await withScope(pool, { teamId }, (db) =>
      db.query(
        `INSERT INTO openpurpose_links (team_id, url, token_sealed) VALUES ($1, $2, $3)
         ON CONFLICT (team_id) DO UPDATE
           SET url = EXCLUDED.url, token_sealed = EXCLUDED.token_sealed, updated_at = now()`,
        [teamId, body.url, vault.seal(body.token)],
      ),
    );
    glossary.forget(teamId);
    return { ok: true };
  });

  app.delete('/api/t/:team/openpurpose', async (request) => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, (db) => db.query('DELETE FROM openpurpose_links'));
    glossary.forget(teamId);
    return { ok: true };
  });

  app.get('/api/t/:team/projects/:project/terms', async (request): Promise<Glossary> => {
    const { team, project } = z
      .object({ team: z.string().max(63), project: z.string().max(63) })
      .parse(request.params);
    const { teamId } = await teamAccess(pool, request, team);
    return withScope(pool, { teamId }, (db) => glossary.read(db, teamId, project));
  });
}
