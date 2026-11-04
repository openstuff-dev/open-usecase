import type { Inbox, InboxItem, UseCaseStatus } from '@open-usecase/contracts';
import type { Actor } from '../auth.js';
import type { Client } from '../db.js';
import { assignScenarioTags, GherkinError, splitForReview } from '../domain/gherkin.js';
import { tryParseRemote } from '../domain/remote.js';
import { HttpError, notFound } from '../errors.js';

export interface ProposeResult {
  id: string;
  ref: string;
  status: UseCaseStatus;
  revision: number;
  scenarios: { id: string; name: string }[];
  gherkin: string;
}

interface ProjectRow {
  id: string;
  language: string;
}

const tagged = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GherkinError) throw new HttpError(400, error.message);
    throw error;
  }
};

/** The project a git remote belongs to, in the team this transaction sees. */
async function projectOfRemote(db: Client, remote: string): Promise<ProjectRow | null> {
  const key = tryParseRemote(remote)?.key;
  if (!key) return null;
  const { rows } = await db.query<ProjectRow>(
    `SELECT p.id, p.language FROM repositories r JOIN projects p ON p.id = r.project_id
      WHERE r.remote_key = $1`,
    [key],
  );
  return rows.at(0) ?? null;
}

const refOf = (number: number) => `UC-${String(number)}`;

/** Joins a use case `u` to its latest revision and its live one. */
const REVISION_JOINS = `
  JOIN LATERAL (
    SELECT * FROM revisions WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM revisions WHERE use_case_id = u.id AND state = 'live' LIMIT 1
  ) live ON true`;

/** The status: worked out, so there's one source of truth. Needs REVISION_JOINS. */
const STATUS = `CASE WHEN u.retired_at IS NOT NULL THEN 'retired'
                     WHEN live.id IS NOT NULL THEN 'done'
                     ELSE latest.state END`;

const REF = /^UC-(\d{1,9})$/;

/** Finds `UC-142` in a remote's project. Other teams' use cases simply aren't there. */
async function useCaseByRef(
  db: Client,
  remote: string,
  ref: string,
): Promise<{
  id: string;
  number: number;
  language: string;
  nextScenario: number;
  retired: boolean;
} | null> {
  const number = REF.exec(ref)?.[1];
  const project = await projectOfRemote(db, remote);
  if (!number || !project) return null;
  const { rows } = await db.query<{
    id: string;
    number: number;
    nextScenario: number;
    retired: boolean;
  }>(
    `SELECT id, number, next_scenario_number AS "nextScenario", retired_at IS NOT NULL AS retired
       FROM use_cases
      WHERE project_id = $1 AND number = $2 FOR UPDATE`,
    [project.id, Number(number)],
  );
  const row = rows.at(0);
  return row ? { ...row, language: project.language } : null;
}

export async function proposeUseCase(
  db: Client,
  actor: Actor,
  input: { remote: string; title: string; gherkin: string; originalRequest?: string | undefined },
): Promise<ProposeResult> {
  const project = await projectOfRemote(db, input.remote);
  if (!project) {
    throw new HttpError(
      404,
      `The repository ${input.remote} isn't in this team. Ask a person to add it to a project.`,
    );
  }
  // Check the text before taking a number, so a refused proposal doesn't use one up.
  const { gherkin, scenarios, nextNumber } = tagged(() =>
    assignScenarioTags(input.gherkin, project.language, new Set(), 1),
  );
  const { rows } = await db.query<{ number: number }>(
    `UPDATE projects SET next_usecase_number = next_usecase_number + 1 WHERE id = $1
     RETURNING next_usecase_number - 1 AS number`,
    [project.id],
  );
  const number = rows[0]?.number ?? 0;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO use_cases (team_id, project_id, number, title, next_scenario_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [actor.teamId, project.id, number, input.title, nextNumber],
  );
  const id = inserted.rows[0]?.id ?? '';
  await db.query(
    `INSERT INTO scenarios (team_id, use_case_id, number) SELECT $1, $2, unnest($3::int[])`,
    [actor.teamId, id, scenarios.map((s) => s.number)],
  );
  await db.query(
    `INSERT INTO revisions
       (team_id, use_case_id, number, gherkin, original_request, proposed_by, scenario_numbers)
     VALUES ($1, $2, 1, $3, $4, $5, $6)`,
    [
      actor.teamId,
      id,
      gherkin,
      input.originalRequest ?? null,
      actor.id,
      scenarios.map((s) => s.number),
    ],
  );
  return {
    id,
    ref: refOf(number),
    status: 'proposed',
    revision: 1,
    gherkin,
    scenarios: scenarios.map((s) => ({
      id: `${refOf(number)}/S${String(s.number)}`,
      name: s.name,
    })),
  };
}

/**
 * New Gherkin for a use case, in two cases. After a person asked for changes, only the agent that
 * proposed it may revise it. A done use case can be changed by any agent of the team: the live
 * revision stays in force until the new one goes live.
 */
export async function reviseUseCase(
  db: Client,
  actor: Actor,
  input: { remote: string; ref: string; gherkin: string; whatChanged: string },
): Promise<ProposeResult> {
  const useCase = await useCaseByRef(db, input.remote, input.ref);
  if (!useCase) throw notFound(input.ref);
  const { rows } = await db.query<{
    number: number;
    state: string;
    proposedBy: string;
    originalRequest: string | null;
  }>(
    `SELECT number, state, proposed_by AS "proposedBy", original_request AS "originalRequest"
       FROM revisions
      WHERE use_case_id = $1 ORDER BY number DESC LIMIT 1`,
    [useCase.id],
  );
  const latest = rows.at(0);
  if (!latest) throw notFound(input.ref);
  if (useCase.retired) {
    throw new HttpError(409, `${input.ref} is retired. Propose a new use case instead.`);
  }
  if (latest.state === 'rejected') {
    throw new HttpError(409, `${input.ref} was rejected. Propose a new use case if it's still needed.`);
  }
  if (latest.state === 'changes_requested' && latest.proposedBy !== actor.id) {
    throw new HttpError(403, `Only the agent that proposed ${input.ref} can revise it.`);
  }
  if (latest.state !== 'changes_requested' && latest.state !== 'live') {
    throw new HttpError(
      409,
      `${input.ref}'s latest revision is "${latest.state}". It can be revised only when changes are requested or it's done.`,
    );
  }
  const known = await db.query<{ number: number }>(
    'SELECT number FROM scenarios WHERE use_case_id = $1',
    [useCase.id],
  );
  const { gherkin, scenarios, nextNumber } = tagged(() =>
    assignScenarioTags(
      input.gherkin,
      useCase.language,
      new Set(known.rows.map((r) => r.number)),
      useCase.nextScenario,
    ),
  );
  await db.query('UPDATE use_cases SET next_scenario_number = $2 WHERE id = $1', [
    useCase.id,
    nextNumber,
  ]);
  await db.query(
    `INSERT INTO scenarios (team_id, use_case_id, number) SELECT $1, $2, unnest($3::int[])
     ON CONFLICT DO NOTHING`,
    [actor.teamId, useCase.id, scenarios.map((s) => s.number)],
  );
  const revision = latest.number + 1;
  await db.query(
    // The request stays with every revision: the reviewer still checks against it.
    `INSERT INTO revisions
       (team_id, use_case_id, number, gherkin, what_changed, original_request, proposed_by,
        scenario_numbers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actor.teamId,
      useCase.id,
      revision,
      gherkin,
      input.whatChanged,
      latest.originalRequest,
      actor.id,
      scenarios.map((s) => s.number),
    ],
  );
  const ref = refOf(useCase.number);
  return {
    id: useCase.id,
    ref,
    status: 'proposed',
    revision,
    gherkin,
    scenarios: scenarios.map((s) => ({ id: `${ref}/S${String(s.number)}`, name: s.name })),
  };
}

/** Adds a comment to the latest revision. */
async function addComment(
  db: Client,
  actor: Actor,
  useCaseId: string,
  ref: string,
  body: string,
  scenario: number | undefined,
): Promise<{ id: string }> {
  if (scenario !== undefined) {
    const known = await db.query('SELECT 1 FROM scenarios WHERE use_case_id = $1 AND number = $2', [
      useCaseId,
      scenario,
    ]);
    if (!known.rowCount) throw notFound(`${ref}/S${String(scenario)}`);
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO comments (team_id, use_case_id, revision_id, scenario_number, body, author_id)
     SELECT $1, $2, r.id, $3, $4, $5 FROM revisions r
      WHERE r.use_case_id = $2 ORDER BY r.number DESC LIMIT 1
     RETURNING id`,
    [actor.teamId, useCaseId, scenario ?? null, body, actor.id],
  );
  const row = rows.at(0);
  if (!row) throw notFound(ref);
  return row;
}

/** An agent replies to review feedback, naming the use case by its remote and `UC-142`. */
export async function commentByRef(
  db: Client,
  actor: Actor,
  input: { remote: string; ref: string; body: string; scenario?: number | undefined },
): Promise<{ id: string }> {
  const useCase = await useCaseByRef(db, input.remote, input.ref);
  if (!useCase) throw notFound(input.ref);
  return addComment(db, actor, useCase.id, input.ref, input.body, input.scenario);
}

/** A person's comment on the use case they're reviewing. */
export async function commentById(
  db: Client,
  actor: Actor,
  id: string,
  input: { body: string; scenario?: number | undefined },
): Promise<{ id: string }> {
  return addComment(db, actor, id, 'That use case', input.body, input.scenario);
}

/** Decides the waiting revision. Whoever comes second gets a clear answer, not a decision. */
async function decide(
  db: Client,
  actor: Actor,
  id: string,
  state: 'approved' | 'changes_requested' | 'rejected',
): Promise<{ status: UseCaseStatus }> {
  const { rows } = await db.query(
    `UPDATE revisions SET state = $2, decided_by = $3, decided_at = now(),
            approval_method = CASE WHEN $2 = 'approved' THEN 'human' END
      WHERE use_case_id = $1 AND state = 'proposed' RETURNING id`,
    [id, state, actor.id],
  );
  if (rows.length) return { status: await statusOf(db, id) };
  const exists = await db.query('SELECT 1 FROM use_cases WHERE id = $1', [id]);
  if (!exists.rowCount) throw notFound('That use case');
  throw new HttpError(409, 'That use case isn’t waiting for review any more.');
}

async function statusOf(db: Client, id: string): Promise<UseCaseStatus> {
  const { rows } = await db.query<{ status: UseCaseStatus }>(
    `SELECT ${STATUS} AS status FROM use_cases u ${REVISION_JOINS} WHERE u.id = $1`,
    [id],
  );
  return rows.at(0)?.status ?? 'proposed';
}

export const approveUseCase = (db: Client, actor: Actor, id: string) =>
  decide(db, actor, id, 'approved');

/** The person says what should change. It joins any comments they left on single scenarios. */
export async function requestChanges(
  db: Client,
  actor: Actor,
  id: string,
  changes: string,
): Promise<{ status: UseCaseStatus }> {
  const decided = await decide(db, actor, id, 'changes_requested');
  await addComment(db, actor, id, 'That use case', changes, undefined);
  return decided;
}

/** Only people reject. The use case and its reason stay visible and searchable. */
export async function rejectUseCase(
  db: Client,
  actor: Actor,
  id: string,
  reason: string,
): Promise<{ status: UseCaseStatus }> {
  const decided = await decide(db, actor, id, 'rejected');
  await addComment(db, actor, id, 'That use case', reason, undefined);
  return decided;
}

/** An agent asks for retirement. It only files the request: a person decides, whatever the mode. */
export async function requestRetirement(
  db: Client,
  actor: Actor,
  input: { remote: string; ref: string; reason: string },
): Promise<void> {
  const useCase = await useCaseByRef(db, input.remote, input.ref);
  if (!useCase) throw notFound(input.ref);
  if (useCase.retired) throw new HttpError(409, `${input.ref} is already retired.`);
  const { rowCount } = await db.query(
    `UPDATE use_cases SET retirement_requested_at = now(), retirement_requested_by = $2,
            retirement_request_reason = $3
      WHERE id = $1 AND EXISTS (
        SELECT 1 FROM revisions WHERE use_case_id = $1 AND state = 'live')`,
    [useCase.id, actor.id, input.reason],
  );
  if (!rowCount) {
    throw new HttpError(409, `${input.ref} isn't done, so there's nothing to retire.`);
  }
}

/** A person retires a use case. It stays visible and searchable, and its ID is never reused. */
export async function retireUseCase(
  db: Client,
  actor: Actor,
  id: string,
  reason: string,
): Promise<{ status: UseCaseStatus }> {
  const { rowCount } = await db.query(
    `UPDATE use_cases SET retired_at = now(), retired_by = $2, retire_reason = $3,
            retirement_requested_at = NULL, retirement_requested_by = NULL,
            retirement_request_reason = NULL
      WHERE id = $1 AND retired_at IS NULL`,
    [id, actor.id, reason],
  );
  if (!rowCount) throw new HttpError(409, 'That use case wasn’t found, or is already retired.');
  return { status: 'retired' };
}

/** A person decides against an agent's request. The use case stays as it is. */
export async function keepUseCase(db: Client, id: string): Promise<{ status: UseCaseStatus }> {
  const { rowCount } = await db.query(
    `UPDATE use_cases SET retirement_requested_at = NULL, retirement_requested_by = NULL,
            retirement_request_reason = NULL
      WHERE id = $1 AND retirement_requested_at IS NOT NULL`,
    [id],
  );
  if (!rowCount) throw new HttpError(409, 'Nobody is asking to retire that use case any more.');
  return { status: await statusOf(db, id) };
}

export interface UseCaseComment {
  scenario: number | null;
  revision: number;
  body: string;
  author: string;
}

export interface ReadUseCase {
  ref: string;
  title: string;
  status: UseCaseStatus;
  /** The latest revision. While it's approved, this is the approved text. */
  revision: number;
  revisionState: string;
  gherkin: string;
  /** The revision in force, when a done use case has a newer one on the way. */
  live: { revision: number; gherkin: string } | null;
  retireReason: string | null;
  retirementRequested: boolean;
  comments: UseCaseComment[];
}

/** One use case as an agent reads it, in one query. Another team's simply isn't there. */
export async function readUseCase(
  db: Client,
  input: { remote: string; ref: string },
): Promise<ReadUseCase> {
  const number = REF.exec(input.ref)?.[1];
  const key = tryParseRemote(input.remote)?.key;
  if (!number || !key) throw notFound(input.ref);
  const { rows } = await db.query<Omit<ReadUseCase, 'ref'>>(
    `SELECT u.title, ${STATUS} AS status, latest.number AS revision,
            latest.state AS "revisionState", latest.gherkin,
            CASE WHEN live.id IS NOT NULL AND live.id <> latest.id
                 THEN json_build_object('revision', live.number, 'gherkin', live.gherkin) END AS live,
            u.retire_reason AS "retireReason",
            u.retirement_requested_at IS NOT NULL AS "retirementRequested",
            coalesce((
              SELECT json_agg(json_build_object(
                       'scenario', c.scenario_number, 'revision', cr.number,
                       'body', c.body, 'author', a.name
                     ) ORDER BY c.created_at)
                FROM comments c
                JOIN revisions cr ON cr.id = c.revision_id
                JOIN actors a ON a.id = c.author_id
               WHERE c.use_case_id = u.id
            ), '[]') AS comments
       FROM repositories rp
       JOIN use_cases u ON u.project_id = rp.project_id
       ${REVISION_JOINS}
      WHERE rp.remote_key = $1 AND u.number = $2`,
    [key, Number(number)],
  );
  const row = rows.at(0);
  if (!row) throw notFound(input.ref);
  return { ...row, ref: input.ref };
}

export interface FoundUseCase {
  ref: string;
  title: string;
  status: UseCaseStatus;
  project: string;
}

/** Every word must match, as a word or the start of one: "colour" finds "colours". */
const toSearchQuery = (words: string): string =>
  (words.match(/[\p{L}\p{N}]+/gu) ?? []).map((word) => `'${word}':*`).join(' & ');

/** Finds this team's use cases by the words in their title and latest text. */
export async function searchUseCases(
  db: Client,
  input: { query: string; status?: UseCaseStatus | undefined },
): Promise<FoundUseCase[]> {
  const query = toSearchQuery(input.query);
  if (!query) throw new HttpError(400, 'Search for at least one word.');
  const { rows } = await db.query<Omit<FoundUseCase, 'ref'> & { number: number }>(
    `SELECT u.number, u.title, ${STATUS} AS status, p.name AS project
       FROM use_cases u
       JOIN projects p ON p.id = u.project_id
       ${REVISION_JOINS}
      WHERE to_tsvector('simple', u.title || ' ' || latest.gherkin) @@ to_tsquery('simple', $1)
        AND ($2::text IS NULL OR ${STATUS} = $2)
      ORDER BY p.name, u.number
      LIMIT 50`,
    [query, input.status ?? null],
  );
  return rows.map(({ number, ...row }) => ({ ...row, ref: refOf(number) }));
}

/** Everything waiting for a person in this team, oldest first, in one query. */
export async function loadInbox(db: Client): Promise<Inbox> {
  const { rows } = await db.query<
    Omit<InboxItem, 'ref' | 'scenarios' | 'preamble'> & {
      number: number;
      gherkin: string;
      language: string;
    }
  >(
    `SELECT u.id, u.number, u.title, r.number AS revision, r.gherkin, p.language,
            json_build_object('slug', p.slug, 'name', p.name) AS project,
            a.name AS "proposedBy", r.created_at AS "proposedAt",
            r.original_request AS "originalRequest", r.what_changed AS "whatChanged",
            r.state = 'proposed' AS "needsReview",
            CASE WHEN u.retirement_requested_at IS NOT NULL THEN json_build_object(
              'requestedBy', ra.name, 'requestedAt', u.retirement_requested_at,
              'reason', u.retirement_request_reason) END AS retirement,
            coalesce((
              SELECT json_agg(json_build_object(
                       'id', c.id, 'revision', cr.number, 'scenario', c.scenario_number,
                       'body', c.body, 'author', ca.name, 'createdAt', c.created_at
                     ) ORDER BY c.created_at)
                FROM comments c
                JOIN revisions cr ON cr.id = c.revision_id
                JOIN actors ca ON ca.id = c.author_id
               WHERE c.use_case_id = u.id
            ), '[]') AS comments
       FROM use_cases u
       JOIN LATERAL (
         SELECT * FROM revisions rv
          WHERE rv.use_case_id = u.id
            AND (rv.state = 'proposed'
                 OR (rv.state = 'live' AND u.retirement_requested_at IS NOT NULL))
          ORDER BY rv.state = 'proposed' DESC, rv.number DESC LIMIT 1
       ) r ON true
       JOIN projects p ON p.id = u.project_id
       JOIN actors a ON a.id = r.proposed_by
       LEFT JOIN actors ra ON ra.id = u.retirement_requested_by
      WHERE u.retired_at IS NULL
      ORDER BY coalesce(u.retirement_requested_at, r.created_at)`,
  );
  return {
    items: rows.map(({ number, gherkin, language, ...row }) => ({
      ...row,
      ref: refOf(number),
      ...splitForReview(gherkin, language),
    })),
  };
}
