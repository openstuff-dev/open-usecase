import type { Client } from '../db.js';
import { readJUnit, JUnitError, type TaggedTest } from '../domain/junit.js';
import { tryParseRemote } from '../domain/remote.js';
import { HttpError, notFound } from '../errors.js';
import type { Actor } from '../auth.js';

export interface ReportAnswer {
  /** Scenarios this report says something about. */
  scenarios: number;
  /** IDs in test names that aren't a scenario, or are retired. They don't fail: people clean up. */
  unknownTags: string[];
  /** Use cases that went live because of this report. */
  wentLive: string[];
}

function parse(xml: string): TaggedTest[] {
  try {
    return readJUnit(xml);
  } catch (error) {
    if (error instanceof JUnitError) throw new HttpError(400, error.message);
    throw error;
  }
}

interface Repository {
  id: string;
  projectId: string;
  defaultBranch: string;
}

async function repositoryOf(db: Client, remote: string): Promise<Repository> {
  const key = tryParseRemote(remote)?.key;
  const { rows } = await db.query<Repository>(
    `SELECT id, project_id AS "projectId", default_branch AS "defaultBranch"
       FROM repositories WHERE remote_key = $1`,
    [key ?? ''],
  );
  const repository = rows.at(0);
  if (!repository) {
    throw new HttpError(
      404,
      `The repository ${remote} isn't in this team. Ask a person to add it to a project.`,
    );
  }
  return repository;
}

interface ScenarioHealth {
  useCaseId: string;
  useCase: number;
  retired: boolean;
  number: number;
  health: string;
}

type Health = Map<string, ScenarioHealth>;

/** The health of every scenario in a project: before and after a change, to see what changed. */
async function projectHealth(db: Client, projectId: string): Promise<Health> {
  const { rows } = await db.query<ScenarioHealth>(
    `SELECT s.use_case_id AS "useCaseId", u.number AS "useCase", u.retired_at IS NOT NULL AS retired,
            s.number, scenario_health(s.use_case_id, s.number) AS health
       FROM scenarios s JOIN use_cases u ON u.id = s.use_case_id WHERE u.project_id = $1`,
    [projectId],
  );
  return new Map(rows.map((row) => [`${row.useCaseId}/${String(row.number)}`, row]));
}

/** History gets a row only when health changed, so a repeat report adds nothing. */
async function recordChanges(
  db: Client,
  actor: Pick<Actor, 'teamId'>,
  before: Health,
  after: Health,
  commit: string | null,
): Promise<void> {
  const changed = [...after].filter(([key, now]) => before.get(key)?.health !== now.health);
  if (!changed.length) return;
  await db.query(
    `INSERT INTO scenario_events (team_id, use_case_id, scenario_number, health, commit_sha)
     SELECT $1, * , $5 FROM unnest($2::uuid[], $3::int[], $4::text[])`,
    [
      actor.teamId,
      changed.map(([, s]) => s.useCaseId),
      changed.map(([, s]) => s.number),
      changed.map(([, s]) => s.health),
      commit,
    ],
  );
}

/**
 * A claimed revision goes live once every scenario in it is passing or manually verified. Without
 * the claim, a new revision can't go live just because the old scenarios' tests still pass.
 */
async function promoteClaimed(db: Client, projectId: string, health: Health): Promise<string[]> {
  const { rows } = await db.query<{
    id: string;
    useCaseId: string;
    number: number;
    scenarios: number[];
  }>(
    `SELECT r.id, r.use_case_id AS "useCaseId", u.number, r.scenario_numbers AS scenarios
       FROM revisions r JOIN use_cases u ON u.id = r.use_case_id
      WHERE u.project_id = $1 AND r.state = 'approved' AND r.claimed_done_at IS NOT NULL
        AND u.retired_at IS NULL`,
    [projectId],
  );
  const ready = rows.filter(
    (r) =>
      r.scenarios.length > 0 &&
      r.scenarios.every((n) => health.get(`${r.useCaseId}/${String(n)}`)?.health === 'passing'),
  );
  if (!ready.length) return [];
  await db.query(
    `WITH old AS (
       UPDATE revisions SET state = 'superseded'
        WHERE state = 'live' AND use_case_id = ANY($2::uuid[]) RETURNING id)
     UPDATE revisions SET state = 'live' WHERE id = ANY($1::uuid[]) AND (SELECT count(*) FROM old) >= 0`,
    [ready.map((r) => r.id), ready.map((r) => r.useCaseId)],
  );
  return ready.map((r) => `UC-${String(r.number)}`);
}

/** Replaces this repository and suite's results with what the report says. The file isn't kept. */
export async function uploadReport(
  db: Client,
  actor: Pick<Actor, 'teamId'>,
  input: { remote: string; branch: string; suite: string; commit: string; junit: string },
): Promise<ReportAnswer> {
  const tests = parse(input.junit);
  const repository = await repositoryOf(db, input.remote);
  if (input.branch !== repository.defaultBranch) {
    throw new HttpError(
      409,
      `Reports only count from the default branch, ${repository.defaultBranch}. This one is from ${input.branch}. Use "openusecase check" on pull requests.`,
    );
  }
  const before = await projectHealth(db, repository.projectId);
  const known = new Map(
    [...before.values()].map((s) => [`UC-${String(s.useCase)}/S${String(s.number)}`, s]),
  );

  const results = new Map<
    string,
    { useCaseId: string; scenario: number; failed: boolean; tests: string[] }
  >();
  const unknown = new Set<string>();
  for (const test of tests) {
    const tag = `UC-${String(test.useCase)}/S${String(test.scenario)}`;
    const scenario = known.get(tag);
    if (!scenario || scenario.retired) {
      unknown.add(tag);
      continue;
    }
    if (test.result === 'skipped') continue; // A skipped test didn't run, so it proves nothing.
    const entry = results.get(tag) ?? {
      useCaseId: scenario.useCaseId,
      scenario: test.scenario,
      failed: false,
      tests: [],
    };
    entry.failed ||= test.result === 'failed';
    entry.tests.push(test.name);
    results.set(tag, entry);
  }
  const rows = [...results.values()];
  await db.query('DELETE FROM scenario_results WHERE repository_id = $1 AND suite = $2', [
    repository.id,
    input.suite,
  ]);
  await db.query(
    `INSERT INTO scenario_results
       (team_id, use_case_id, scenario_number, repository_id, suite, result, tests, commit_sha)
     SELECT $1, u, n, $2, $3, r, ARRAY(SELECT jsonb_array_elements_text(t)), $4
       FROM unnest($5::uuid[], $6::int[], $7::text[], $8::jsonb[]) AS x(u, n, r, t)`,
    [
      actor.teamId,
      repository.id,
      input.suite,
      input.commit,
      rows.map((r) => r.useCaseId),
      rows.map((r) => r.scenario),
      rows.map((r) => (r.failed ? 'failed' : 'passed')),
      rows.map((r) => JSON.stringify(r.tests)),
    ],
  );
  const after = await projectHealth(db, repository.projectId);
  await recordChanges(db, actor, before, after, input.commit);
  const wentLive = await promoteClaimed(db, repository.projectId, after);
  return { scenarios: rows.length, unknownTags: [...unknown].sort(), wentLive };
}

/** The agent says it merged. The next report decides whether the revision goes live. */
export async function claimDone(
  db: Client,
  input: { remote: string; ref: string; prUrl: string; mergeSha: string },
): Promise<void> {
  const repository = await repositoryOf(db, input.remote);
  const number = /^UC-(\d{1,9})$/.exec(input.ref)?.[1];
  const { rows } = await db.query<{ id: string; state: string }>(
    `SELECT r.id, r.state FROM use_cases u
       JOIN LATERAL (
         SELECT id, state FROM revisions WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1
       ) r ON true
      WHERE u.project_id = $1 AND u.number = $2`,
    [repository.projectId, Number(number ?? -1)],
  );
  const latest = rows.at(0);
  if (!latest) throw notFound(input.ref);
  if (latest.state !== 'approved') {
    throw new HttpError(
      409,
      `${input.ref}'s latest revision is "${latest.state}", so it can't be claimed as done.`,
    );
  }
  await db.query(
    'UPDATE revisions SET pr_url = $2, merge_sha = $3, claimed_done_at = now() WHERE id = $1',
    [latest.id, input.prUrl, input.mergeSha],
  );
}

/** A person says they checked a scenario by hand. It counts, and is labelled as manual. */
export async function verifyManually(
  db: Client,
  actor: Actor,
  input: { useCaseId: string; scenario: number; note: string },
): Promise<void> {
  const { rows } = await db.query<{ projectId: string }>(
    `SELECT u.project_id AS "projectId" FROM use_cases u JOIN scenarios s ON s.use_case_id = u.id
      WHERE u.id = $1 AND s.number = $2`,
    [input.useCaseId, input.scenario],
  );
  const found = rows.at(0);
  if (!found) throw notFound('That scenario');
  const before = await projectHealth(db, found.projectId);
  await db.query(
    `INSERT INTO manual_verifications (team_id, use_case_id, scenario_number, verified_by, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor.teamId, input.useCaseId, input.scenario, actor.id, input.note],
  );
  const after = await projectHealth(db, found.projectId);
  await recordChanges(db, actor, before, after, null);
  await promoteClaimed(db, found.projectId, after);
}

export interface CheckAnswer {
  ok: boolean;
  /** Why it fails. */
  problems: string[];
  /** What's worth knowing, but doesn't fail it. */
  notes: string[];
}

/** The PR check. It stores nothing. */
export async function checkPullRequest(
  db: Client,
  input: {
    remote: string;
    useCases: string[];
    exemption?: string | undefined;
    junit?: string | undefined;
  },
): Promise<CheckAnswer> {
  const repository = await repositoryOf(db, input.remote);
  if (!input.useCases.length) {
    if (input.exemption?.trim()) {
      return { ok: true, problems: [], notes: [`Exempt: ${input.exemption.trim()}`] };
    }
    return {
      ok: false,
      problems: [
        'Name the use cases in the PR body, "Use cases: UC-142, UC-150", or say why there are none, "No use case: <reason>".',
      ],
      notes: [],
    };
  }
  const tested = new Set(
    (input.junit ? parse(input.junit) : [])
      .filter((t) => t.result !== 'skipped')
      .map((t) => `UC-${String(t.useCase)}/S${String(t.scenario)}`),
  );
  const numbers = input.useCases.map((ref) => Number(/^UC-(\d{1,9})$/.exec(ref)?.[1] ?? -1));
  const { rows } = await db.query<{
    number: number;
    retired: boolean;
    state: string;
    scenarios: number[];
    elsewhere: number[];
    manual: number[];
  }>(
    `SELECT u.number, u.retired_at IS NOT NULL AS retired, latest.state,
            latest.scenario_numbers AS scenarios,
            ARRAY(SELECT DISTINCT r.scenario_number FROM scenario_results r
                   WHERE r.use_case_id = u.id AND r.repository_id <> $3) AS elsewhere,
            ARRAY(SELECT DISTINCT m.scenario_number FROM manual_verifications m
                   WHERE m.use_case_id = u.id) AS manual
       FROM use_cases u
       JOIN LATERAL (SELECT state, scenario_numbers FROM revisions
                      WHERE use_case_id = u.id ORDER BY number DESC LIMIT 1) latest ON true
      WHERE u.project_id = $1 AND u.number = ANY($2::int[])`,
    [repository.projectId, numbers, repository.id],
  );
  const problems: string[] = [];
  const notes: string[] = [];
  input.useCases.forEach((ref, i) => {
    const useCase = rows.find((r) => r.number === numbers[i]);
    if (!useCase) {
      problems.push(`${ref} wasn't found in this project.`);
    } else if (useCase.retired) {
      problems.push(`${ref} is retired.`);
    } else if (useCase.state !== 'approved' && useCase.state !== 'live') {
      const state = useCase.state.replace('_', ' ');
      problems.push(`${ref} isn't approved. Its latest revision is "${state}".`);
    } else {
      for (const scenario of useCase.scenarios) {
        const id = `${ref}/S${String(scenario)}`;
        if (tested.has(id)) continue;
        if (useCase.elsewhere.includes(scenario)) notes.push(`${id} is proven in another repository.`);
        else if (useCase.manual.includes(scenario)) notes.push(`${id} was verified by hand.`);
        else problems.push(`${id} has no tagged test.`);
      }
    }
  });
  return { ok: problems.length === 0, problems, notes };
}
