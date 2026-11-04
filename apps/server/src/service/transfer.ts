import type { TeamExport } from '@open-usecase/contracts';
import { z } from 'zod';
import type { Client } from '../db.js';
import { HttpError } from '../errors.js';

/** Everything a team has, as one file. Never tokens or passwords. */
export async function exportTeam(db: Client, teamId: string): Promise<TeamExport> {
  const { rows } = await db.query<{ export: TeamExport }>(
    `SELECT json_build_object(
       'version', 1,
       'exportedAt', now(),
       'team', (SELECT json_build_object('slug', slug, 'name', name) FROM teams WHERE id = $1),
       'actors', coalesce((SELECT json_agg(json_build_object(
           'id', a.id, 'kind', a.kind, 'name', a.name, 'review', a.review, 'canReview', a.can_review
         ) ORDER BY a.name) FROM actors a), '[]'),
       'projects', coalesce((SELECT json_agg(json_build_object(
           'slug', p.slug, 'name', p.name, 'language', p.language,
           'nextUseCaseNumber', p.next_usecase_number,
           'repositories', coalesce((SELECT json_agg(json_build_object(
               'remote', r.remote_key, 'defaultBranch', r.default_branch) ORDER BY r.remote_key)
             FROM repositories r WHERE r.project_id = p.id), '[]'),
           'useCases', coalesce((SELECT json_agg(json_build_object(
               'number', u.number, 'title', u.title, 'nextScenarioNumber', u.next_scenario_number,
               'scenarios', (SELECT coalesce(json_agg(s.number ORDER BY s.number), '[]')
                               FROM scenarios s WHERE s.use_case_id = u.id),
               'retiredAt', u.retired_at, 'retiredBy', u.retired_by,
               'retireReason', u.retire_reason,
               'revisions', (SELECT json_agg(json_build_object(
                   'number', r.number, 'gherkin', r.gherkin,
                   'originalRequest', r.original_request, 'whatChanged', r.what_changed,
                   'state', r.state, 'reviewMode', r.review_mode, 'proposedBy', r.proposed_by,
                   'decidedBy', r.decided_by, 'decidedAt', r.decided_at,
                   'approvalMethod', r.approval_method, 'prUrl', r.pr_url, 'mergeSha', r.merge_sha,
                   'claimedDoneAt', r.claimed_done_at, 'createdAt', r.created_at
                 ) ORDER BY r.number) FROM revisions r WHERE r.use_case_id = u.id),
               'comments', coalesce((SELECT json_agg(json_build_object(
                   'revision', cr.number, 'scenario', c.scenario_number, 'body', c.body,
                   'author', c.author_id, 'createdAt', c.created_at) ORDER BY c.created_at)
                 FROM comments c JOIN revisions cr ON cr.id = c.revision_id
                 WHERE c.use_case_id = u.id), '[]'),
               'manual', coalesce((SELECT json_agg(json_build_object(
                   'scenario', m.scenario_number, 'by', m.verified_by, 'at', m.verified_at,
                   'note', m.note) ORDER BY m.verified_at)
                 FROM manual_verifications m WHERE m.use_case_id = u.id), '[]'),
               'history', coalesce((SELECT json_agg(json_build_object(
                   'scenario', e.scenario_number, 'health', e.health, 'commit', e.commit_sha,
                   'at', e.created_at) ORDER BY e.created_at)
                 FROM scenario_events e WHERE e.use_case_id = u.id), '[]')
             ) ORDER BY u.number) FROM use_cases u WHERE u.project_id = p.id), '[]')
         ) ORDER BY p.slug) FROM projects p), '[]')
     ) AS export`,
    [teamId],
  );
  return (rows[0]).export;
}

const shape = z.object({
  version: z.literal(1),
  actors: z.array(z.object({ id: z.string() }).loose()),
  projects: z.array(z.object({ slug: z.string() }).loose()),
});

/**
 * Loads an export into a team that has no projects yet. Actors come back by name, without accounts
 * or tokens: people sign in as themselves, and agents get new tokens. Test results aren't in the
 * file, because CI's next report brings them back; the history of what happened stays.
 */
export async function importTeam(
  db: Client,
  teamId: string,
  data: TeamExport,
): Promise<{ projects: number; useCases: number }> {
  const parsed = shape.safeParse(data);
  if (!parsed.success) throw new HttpError(400, 'That isn’t an OpenUsecase export.');
  const existing = await db.query('SELECT 1 FROM projects LIMIT 1');
  if (existing.rowCount) {
    throw new HttpError(409, 'This team already has projects. Import into an empty team.');
  }
  const actorIds = new Map<string, string>();
  for (const actor of data.actors) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actors (team_id, kind, name, review, can_review)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teamId, actor.kind, actor.name, actor.review, actor.canReview],
    );
    actorIds.set(actor.id, rows[0]?.id ?? '');
  }
  const actor = (id: string | null): string | null => (id ? (actorIds.get(id) ?? null) : null);
  let useCases = 0;
  for (const project of data.projects) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO projects (team_id, slug, name, language, next_usecase_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [teamId, project.slug, project.name, project.language, project.nextUseCaseNumber],
    );
    const projectId = rows[0]?.id ?? '';
    for (const repository of project.repositories) {
      await db.query(
        `INSERT INTO repositories (team_id, project_id, remote_key, default_branch)
         VALUES ($1, $2, $3, $4)`,
        [teamId, projectId, repository.remote, repository.defaultBranch],
      );
    }
    for (const useCase of project.useCases) {
      useCases++;
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO use_cases (team_id, project_id, number, title, next_scenario_number,
                                retired_at, retired_by, retire_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          teamId,
          projectId,
          useCase.number,
          useCase.title,
          useCase.nextScenarioNumber,
          useCase.retiredAt,
          actor(useCase.retiredBy),
          useCase.retireReason,
        ],
      );
      const id = inserted.rows[0]?.id ?? '';
      await db.query(
        'INSERT INTO scenarios (team_id, use_case_id, number) SELECT $1, $2, unnest($3::int[])',
        [teamId, id, useCase.scenarios],
      );
      const revisionIds = new Map<number, string>();
      for (const revision of useCase.revisions) {
        const made = await db.query<{ id: string }>(
          `INSERT INTO revisions
             (team_id, use_case_id, number, gherkin, original_request, what_changed, state,
              review_mode, proposed_by, decided_by, decided_at, approval_method, pr_url, merge_sha,
              claimed_done_at, created_at, scenario_numbers)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             coalesce((SELECT array_agg(m[1]::int) FROM regexp_matches($4, '@S(\\d+)\\M', 'g') AS m), '{}'))
           RETURNING id`,
          [
            teamId,
            id,
            revision.number,
            revision.gherkin,
            revision.originalRequest,
            revision.whatChanged,
            revision.state,
            revision.reviewMode,
            actor(revision.proposedBy),
            actor(revision.decidedBy),
            revision.decidedAt,
            revision.approvalMethod,
            revision.prUrl,
            revision.mergeSha,
            revision.claimedDoneAt,
            revision.createdAt,
          ],
        );
        revisionIds.set(revision.number, made.rows[0]?.id ?? '');
      }
      for (const comment of useCase.comments) {
        await db.query(
          `INSERT INTO comments (team_id, use_case_id, revision_id, scenario_number, body,
                                 author_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            teamId,
            id,
            revisionIds.get(comment.revision),
            comment.scenario,
            comment.body,
            actor(comment.author),
            comment.createdAt,
          ],
        );
      }
      for (const manual of useCase.manual) {
        await db.query(
          `INSERT INTO manual_verifications (team_id, use_case_id, scenario_number, verified_by,
                                             verified_at, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [teamId, id, manual.scenario, actor(manual.by), manual.at, manual.note],
        );
      }
      for (const event of useCase.history) {
        await db.query(
          `INSERT INTO scenario_events (team_id, use_case_id, scenario_number, health, commit_sha,
                                        created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [teamId, id, event.scenario, event.health, event.commit, event.at],
        );
      }
    }
  }
  return { projects: data.projects.length, useCases };
}
