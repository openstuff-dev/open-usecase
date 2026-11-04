import type {
  Catalogue,
  RevisionSummary,
  ScenarioEvidence,
  UseCaseDetail,
} from '@open-usecase/contracts';
import type { Client } from '../db.js';
import { splitForReview } from '../domain/gherkin.js';
import { notFound } from '../errors.js';

const JOINS = `
  JOIN projects p ON p.id = u.project_id
  JOIN LATERAL (
    SELECT * FROM revisions WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM revisions WHERE use_case_id = u.id AND state = 'live' LIMIT 1
  ) live ON true`;

const STATUS = `CASE WHEN u.retired_at IS NOT NULL THEN 'retired'
                     WHEN live.id IS NOT NULL THEN 'done'
                     ELSE latest.state END`;

/** Every use case of the team, with status and health, in one query. */
export async function loadCatalogue(db: Client): Promise<Catalogue> {
  const { rows } = await db.query<Catalogue['items'][number] & { number: number }>(
    `SELECT u.id, u.number, u.title, json_build_object('slug', p.slug, 'name', p.name) AS project,
            ar.name AS area,
            ${STATUS} AS status,
            use_case_health(u.id, coalesce(live.scenario_numbers, latest.scenario_numbers)) AS health,
            coalesce(live.approval_method, latest.approval_method) AS approval,
            coalesce(live.number, latest.number) AS revision,
            u.retired_at IS NULL AND (
              u.retirement_requested_at IS NOT NULL OR latest.state = 'proposed'
              OR (live.id IS NOT NULL AND live.id <> latest.id)) AS pending
       FROM use_cases u ${JOINS}
       LEFT JOIN areas ar ON ar.id = u.area_id
      ORDER BY p.name, ar.name NULLS LAST, u.number`,
  );
  return { items: rows.map(({ number, ...row }) => ({ ...row, ref: `UC-${String(number)}` })) };
}

interface DetailRow extends Omit<UseCaseDetail, 'ref' | 'preamble' | 'scenarios' | 'newer'> {
  number: number;
  language: string;
  gherkin: string;
  newerRevision: { revision: number; state: string; gherkin: string } | null;
  evidence: Omit<ScenarioEvidence, 'name' | 'blocks'>[];
  revisions: RevisionSummary[];
}

/** One use case with its revisions, evidence, comments and history, in one query. */
export async function loadUseCase(db: Client, id: string): Promise<UseCaseDetail> {
  const { rows } = await db.query<DetailRow>(
    `WITH current AS (SELECT u.id FROM use_cases u WHERE u.id = $1)
     SELECT u.id, u.number, u.title, p.language,
            json_build_object('slug', p.slug, 'name', p.name) AS project,
            ar.name AS area,
            ARRAY(SELECT a.name FROM areas a WHERE a.project_id = u.project_id ORDER BY a.name) AS areas,
            ${STATUS} AS status,
            use_case_health(u.id, coalesce(live.scenario_numbers, latest.scenario_numbers)) AS health,
            coalesce(live.original_request, latest.original_request) AS "originalRequest",
            u.retired_at AS "retiredAt", rb.name AS "retiredBy", u.retire_reason AS "retireReason",
            CASE WHEN u.retirement_requested_at IS NOT NULL THEN json_build_object(
              'requestedBy', ra.name, 'requestedAt', u.retirement_requested_at,
              'reason', u.retirement_request_reason) END AS retirement,
            coalesce(live.number, latest.number) AS revision,
            coalesce(live.gherkin, latest.gherkin) AS gherkin,
            CASE WHEN live.id IS NOT NULL AND live.id <> latest.id THEN json_build_object(
              'revision', latest.number, 'state', latest.state, 'gherkin', latest.gherkin)
            END AS "newerRevision",
            coalesce((
              SELECT json_agg(json_build_object(
                       'number', n, 'health', scenario_health(u.id, n),
                       'tests', coalesce((
                         SELECT json_agg(json_build_object(
                                  'suite', sr.suite, 'repository', rr.remote_key, 'result', sr.result,
                                  'names', sr.tests, 'commit', sr.commit_sha, 'at', sr.reported_at))
                           FROM scenario_results sr JOIN repositories rr ON rr.id = sr.repository_id
                          WHERE sr.use_case_id = u.id AND sr.scenario_number = n), '[]'),
                       'manual', coalesce((
                         SELECT json_agg(json_build_object(
                                  'by', ma.name, 'at', mv.verified_at, 'note', mv.note)
                                  ORDER BY mv.verified_at)
                           FROM manual_verifications mv JOIN actors ma ON ma.id = mv.verified_by
                          WHERE mv.use_case_id = u.id AND mv.scenario_number = n), '[]')
                     ))
                FROM unnest(coalesce(live.scenario_numbers, latest.scenario_numbers)) n
            ), '[]') AS evidence,
            (SELECT json_agg(json_build_object(
                      'number', r.number, 'state', r.state, 'proposedBy', pa.name,
                      'proposedAt', r.created_at, 'whatChanged', r.what_changed,
                      'approval', r.approval_method, 'decidedBy', da.name, 'decidedAt', r.decided_at,
                      'prUrl', r.pr_url, 'mergeSha', r.merge_sha, 'claimedDoneAt', r.claimed_done_at
                    ) ORDER BY r.number DESC)
               FROM revisions r JOIN actors pa ON pa.id = r.proposed_by
               LEFT JOIN actors da ON da.id = r.decided_by
              WHERE r.use_case_id = u.id) AS revisions,
            coalesce((
              SELECT json_agg(json_build_object(
                       'id', c.id, 'revision', cr.number, 'scenario', c.scenario_number,
                       'body', c.body, 'author', ca.name, 'createdAt', c.created_at
                     ) ORDER BY c.created_at)
                FROM comments c JOIN revisions cr ON cr.id = c.revision_id
                JOIN actors ca ON ca.id = c.author_id
               WHERE c.use_case_id = u.id), '[]') AS comments,
            coalesce((
              SELECT json_agg(json_build_object(
                       'scenario', e.scenario_number, 'health', e.health,
                       'commit', e.commit_sha, 'at', e.created_at) ORDER BY e.created_at DESC)
                FROM scenario_events e WHERE e.use_case_id = u.id), '[]') AS history
       FROM current JOIN use_cases u ON u.id = current.id ${JOINS}
       LEFT JOIN actors rb ON rb.id = u.retired_by
       LEFT JOIN actors ra ON ra.id = u.retirement_requested_by
       LEFT JOIN areas ar ON ar.id = u.area_id`,
    [id],
  );
  const row = rows.at(0);
  if (!row) throw notFound('That use case');
  const { number, language, gherkin, newerRevision, evidence, ...rest } = row;
  const text = splitForReview(gherkin, language);
  const byNumber = new Map(evidence.map((e) => [e.number, e]));
  const newer = newerRevision && {
    revision: newerRevision.revision,
    state: newerRevision.state,
    ...splitForReview(newerRevision.gherkin, language),
  };
  return {
    ...rest,
    ref: `UC-${String(number)}`,
    preamble: text.preamble,
    scenarios: text.scenarios.map((scenario) => ({
      ...scenario,
      health: byNumber.get(scenario.number)?.health ?? 'no_evidence',
      tests: byNumber.get(scenario.number)?.tests ?? [],
      manual: byNumber.get(scenario.number)?.manual ?? [],
    })),
    newer,
  };
}
