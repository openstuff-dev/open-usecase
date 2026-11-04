import type { FastifyInstance } from 'fastify';
import { dialects } from '@cucumber/gherkin';
import { z } from 'zod';
import type { NewMemberResult, TeamSettings } from '@open-usecase/contracts';
import { hashPassword, newPassword, requirePerson, teamAccess } from '../auth.js';
import { withScope, type Pool } from '../db.js';
import { tryParseRemote } from '../domain/remote.js';
import { HttpError, notFound } from '../errors.js';
import { addToken } from '../service/setup.js';

const teamParam = z.object({ team: z.string().max(63) });
const idParam = z.object({ team: z.string().max(63), id: z.uuid().catch('') });
const name = z.string().trim().min(1, 'Give it a name.').max(120);
const branch = z.string().trim().min(1).max(255);
const remoteKey = z.string().trim().max(500).transform((remote, ctx) => {
  const key = tryParseRemote(remote)?.key;
  if (!key) {
    ctx.addIssue({ code: 'custom', message: `${remote} isn't a git remote.` });
    return z.NEVER;
  }
  return key;
});
const language = z.string().refine((code) => code in dialects, 'That isn’t a Gherkin language.');
const role = z.enum(['admin', 'member']);

const slugify = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'team';

/** Projects, members, agents and tokens. Only a team's admins reach these, and never a token. */
export function registerSettingsRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/api/admin/teams', async (request, reply) => {
    const account = requirePerson(request);
    if (!account.isServerAdmin) throw new HttpError(403, 'Only a server admin can add teams.');
    const body = z.object({ name }).parse(request.body);
    const { rows } = await pool.query<{ slug: string; name: string }>(
      'INSERT INTO teams (slug, name) VALUES ($1, $2) RETURNING slug, name',
      [slugify(body.name), body.name],
    );
    return reply.code(201).send(rows[0]);
  });

  app.get('/api/t/:team/settings', async (request): Promise<TeamSettings> => {
    const { team } = teamParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    return withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<TeamSettings>(
        `SELECT
           coalesce((SELECT json_agg(json_build_object(
               'id', p.id, 'slug', p.slug, 'name', p.name, 'language', p.language,
               'repositories', coalesce((SELECT json_agg(json_build_object(
                   'id', r.id, 'remote', r.remote_key, 'defaultBranch', r.default_branch
                 ) ORDER BY r.remote_key) FROM repositories r WHERE r.project_id = p.id), '[]')
             ) ORDER BY p.name) FROM projects p), '[]') AS projects,
           coalesce((SELECT json_agg(json_build_object(
               'accountId', a.id, 'email', a.email, 'name', a.name, 'role', m.role
             ) ORDER BY a.name, a.email)
             FROM memberships m JOIN accounts a ON a.id = m.account_id), '[]') AS members,
           coalesce((SELECT json_agg(json_build_object(
               'id', x.id, 'name', x.name, 'kind', x.kind, 'review', x.review,
               'canReview', x.can_review,
               'tokens', coalesce((SELECT json_agg(json_build_object(
                   'id', t.id, 'prefix', t.prefix, 'createdAt', t.created_at
                 ) ORDER BY t.created_at) FROM api_tokens t
                 WHERE t.actor_id = x.id AND t.revoked_at IS NULL), '[]')
             ) ORDER BY x.kind, x.name) FROM actors x WHERE x.kind <> 'human'), '[]') AS actors`,
      );
      return rows[0];
    });
  });

  app.post('/api/t/:team/projects', async (request, reply) => {
    const { team } = teamParam.parse(request.params);
    const body = z
      .object({ name, remote: remoteKey, language: language.default('en'), defaultBranch: branch.default('main') })
      .parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const id = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO projects (team_id, slug, name, language) VALUES ($1, $2, $3, $4) RETURNING id',
        [teamId, slugify(body.name), body.name, body.language],
      );
      const projectId = rows[0]?.id ?? '';
      await db.query(
        `INSERT INTO repositories (team_id, project_id, remote_key, default_branch)
         VALUES ($1, $2, $3, $4)`,
        [teamId, projectId, body.remote, body.defaultBranch],
      );
      return projectId;
    });
    return reply.code(201).send({ id });
  });

  app.post('/api/t/:team/projects/:id/repositories', async (request, reply) => {
    const { team, id } = idParam.parse(request.params);
    const body = z.object({ remote: remoteKey, defaultBranch: branch.default('main') }).parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, async (db) => {
      const project = await db.query('SELECT 1 FROM projects WHERE id = $1', [id || null]);
      if (!project.rowCount) throw notFound('That project');
      await db.query(
        `INSERT INTO repositories (team_id, project_id, remote_key, default_branch)
         VALUES ($1, $2, $3, $4)`,
        [teamId, id, body.remote, body.defaultBranch],
      );
    });
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/t/:team/repositories/:id', async (request) => {
    const { team, id } = idParam.parse(request.params);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, async (db) => {
      const { rowCount } = await db.query('DELETE FROM repositories WHERE id = $1', [id || null]);
      if (!rowCount) throw notFound('That repository');
    });
    return { ok: true };
  });

  app.post('/api/t/:team/members', async (request, reply) => {
    const { team } = teamParam.parse(request.params);
    const body = z
      .object({ email: z.email().max(200), name: z.string().trim().max(120).default(''), role })
      .parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const email = body.email.toLowerCase();
    const password = newPassword();
    const { rows } = await pool.query<{ id: string; created: boolean }>(
      `INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, (xmax = 0) AS created`,
      [email, body.name, await hashPassword(password)],
    );
    const account = rows[0];
    await withScope(pool, { teamId }, (db) =>
      db.query(
        `INSERT INTO memberships (team_id, account_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
        [teamId, account.id, body.role],
      ),
    );
    const result: NewMemberResult = {
      accountId: account.id,
      password: account.created ? password : null,
    };
    return reply.code(201).send(result);
  });

  app.patch('/api/t/:team/members/:id', async (request) => {
    const { team, id } = idParam.parse(request.params);
    const body = z.object({ role }).parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    await withScope(pool, { teamId }, async (db) => {
      const { rowCount } = await db.query('UPDATE memberships SET role = $2 WHERE account_id = $1', [
        id || null,
        body.role,
      ]);
      if (!rowCount) throw notFound('That member');
    });
    return { ok: true };
  });

  app.delete('/api/t/:team/members/:id', async (request) => {
    const { team, id } = idParam.parse(request.params);
    const { teamId, account } = await teamAccess(pool, request, team, ['admin']);
    if (id === account.id) throw new HttpError(409, 'You can’t remove yourself.');
    await withScope(pool, { teamId }, async (db) => {
      const { rowCount } = await db.query('DELETE FROM memberships WHERE account_id = $1', [id || null]);
      if (!rowCount) throw notFound('That member');
    });
    return { ok: true };
  });

  app.post('/api/t/:team/actors', async (request, reply) => {
    const { team } = teamParam.parse(request.params);
    const body = z.object({ name, kind: z.enum(['agent', 'ci']) }).parse(request.body);
    const { teamId } = await teamAccess(pool, request, team, ['admin']);
    const created = await withScope(pool, { teamId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        'INSERT INTO actors (team_id, kind, name) VALUES ($1, $2, $3) RETURNING id',
        [teamId, body.kind, body.name],
      );
      const actorId = rows[0]?.id ?? '';
      return { actorId, ...(await addToken(db, teamId, actorId)) };
    });
    return reply.code(201).send(created);
  });
}
