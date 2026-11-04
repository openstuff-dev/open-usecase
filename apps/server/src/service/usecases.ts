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

const REF = /^UC-(\d{1,9})$/;

/** Finds `UC-142` in a remote's project. Other teams' use cases simply aren't there. */
async function useCaseByRef(
  db: Client,
  remote: string,
  ref: string,
): Promise<{ id: string; number: number; language: string; nextScenario: number } | null> {
  const number = REF.exec(ref)?.[1];
  const project = await projectOfRemote(db, remote);
  if (!number || !project) return null;
  const { rows } = await db.query<{ id: string; number: number; nextScenario: number }>(
    `SELECT id, number, next_scenario_number AS "nextScenario" FROM use_cases
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
    `INSERT INTO revisions (team_id, use_case_id, number, gherkin, original_request, proposed_by)
     VALUES ($1, $2, 1, $3, $4, $5)`,
    [actor.teamId, id, gherkin, input.originalRequest ?? null, actor.id],
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
 * New Gherkin after a person asked for changes. Only the agent that proposed the use case may
 * revise it, and only while changes are requested.
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
    state: UseCaseStatus;
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
  if (latest.proposedBy !== actor.id) {
    throw new HttpError(403, `Only the agent that proposed ${input.ref} can revise it.`);
  }
  if (latest.state !== 'changes_requested') {
    throw new HttpError(
      409,
      `${input.ref} is "${latest.state}". It can be revised only when changes are requested.`,
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
       (team_id, use_case_id, number, gherkin, what_changed, original_request, proposed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actor.teamId,
      useCase.id,
      revision,
      gherkin,
      input.whatChanged,
      latest.originalRequest,
      actor.id,
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
  state: 'approved' | 'changes_requested',
): Promise<{ status: UseCaseStatus }> {
  const { rows } = await db.query(
    `UPDATE revisions SET state = $2, decided_by = $3, decided_at = now(),
            approval_method = CASE WHEN $2 = 'approved' THEN 'human' END
      WHERE use_case_id = $1 AND state = 'proposed' RETURNING id`,
    [id, state, actor.id],
  );
  if (rows.length) return { status: state };
  const exists = await db.query('SELECT 1 FROM use_cases WHERE id = $1', [id]);
  if (!exists.rowCount) throw notFound('That use case');
  throw new HttpError(409, 'That use case isn’t waiting for review any more.');
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
  revision: number;
  /** The latest revision's text. While it's approved, that is the approved text. */
  gherkin: string;
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
    `SELECT u.title, latest.state AS status, latest.number AS revision, latest.gherkin,
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
       JOIN LATERAL (
         SELECT number, state, gherkin FROM revisions
          WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1
       ) latest ON true
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
    `SELECT u.number, u.title, latest.state AS status, p.name AS project
       FROM use_cases u
       JOIN projects p ON p.id = u.project_id
       JOIN LATERAL (
         SELECT state, gherkin FROM revisions
          WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1
       ) latest ON true
      WHERE to_tsvector('simple', u.title || ' ' || latest.gherkin) @@ to_tsquery('simple', $1)
        AND ($2::text IS NULL OR latest.state = $2)
      ORDER BY p.name, u.number
      LIMIT 50`,
    [query, input.status ?? null],
  );
  return rows.map(({ number, ...row }) => ({ ...row, ref: refOf(number) }));
}

/** Everything waiting for a person in this team, oldest first, in one query. */
export async function loadInbox(db: Client): Promise<Inbox> {
  const { rows } = await db.query<
    Omit<InboxItem, 'ref' | 'scenarios' | 'preamble'> & { number: number; gherkin: string; language: string }
  >(
    `SELECT u.id, u.number, u.title, r.number AS revision, r.gherkin, p.language,
            json_build_object('slug', p.slug, 'name', p.name) AS project,
            a.name AS "proposedBy", r.created_at AS "proposedAt",
            r.original_request AS "originalRequest", r.what_changed AS "whatChanged",
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
       FROM revisions r
       JOIN use_cases u ON u.id = r.use_case_id
       JOIN projects p ON p.id = u.project_id
       JOIN actors a ON a.id = r.proposed_by
      WHERE r.state = 'proposed'
      ORDER BY r.created_at`,
  );
  return {
    items: rows.map(({ number, gherkin, language, ...row }) => ({
      ...row,
      ref: refOf(number),
      ...splitForReview(gherkin, language),
    })),
  };
}
