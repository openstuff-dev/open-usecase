// Puts the trial's use cases into a project, keeping their IDs:
//
//   npm run -w apps/server trial:import -- --team acme --project demo --agent claude \
//     --file docs/trial/usecases.md
//
// Running it twice changes nothing: a number that's already there is skipped.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool, migrate, withScope } from './db.js';
import { parseCatalogueFile } from './domain/catalogue-file.js';
import { parseUseCase } from './domain/gherkin.js';

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    project: { type: 'string' },
    agent: { type: 'string', default: 'agent' },
    file: { type: 'string' },
  },
});
const { team, project, agent, file } = values;
if (!team || !project || !file) {
  throw new Error('Usage: trial:import --team <slug> --project <slug> --file <path> [--agent <name>]');
}

const config = loadConfig();
await migrate(config.databaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)));
const pool = createPool(config.databaseUrl);
try {
  const useCases = parseCatalogueFile(readFileSync(file, 'utf8'));
  const added = await withScope(pool, { bypass: true }, async (db) => {
    const found = await db.query<{
      teamId: string;
      projectId: string;
      language: string;
      actorId: string;
    }>(
      `SELECT t.id AS "teamId", p.id AS "projectId", p.language, a.id AS "actorId"
         FROM teams t JOIN projects p ON p.team_id = t.id
         JOIN actors a ON a.team_id = t.id AND a.kind = 'agent' AND a.name = $3
        WHERE t.slug = $1 AND p.slug = $2`,
      [team, project, agent],
    );
    const target = found.rows.at(0);
    if (!target) {
      throw new Error(`No project "${project}" with an agent "${agent}" in team "${team}".`);
    }
    let count = 0;
    for (const useCase of useCases) {
      const numbers = parseUseCase(useCase.gherkin, target.language).map((s) => s.number ?? 0);
      const inserted = await db.query<{ id: string }>(
        `INSERT INTO use_cases (team_id, project_id, number, title, next_scenario_number)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, number) DO NOTHING RETURNING id`,
        [target.teamId, target.projectId, useCase.number, useCase.title, Math.max(0, ...numbers) + 1],
      );
      const id = inserted.rows.at(0)?.id;
      if (!id) continue;
      count++;
      await db.query(
        `INSERT INTO scenarios (team_id, use_case_id, number) SELECT $1, $2, unnest($3::int[])`,
        [target.teamId, id, numbers],
      );
      await db.query(
        `INSERT INTO revisions
           (team_id, use_case_id, number, gherkin, state, proposed_by, approval_method,
            decided_at, scenario_numbers)
         VALUES ($1, $2, 1, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7)`,
        [
          target.teamId,
          id,
          useCase.gherkin,
          useCase.approved ? 'approved' : 'proposed',
          target.actorId,
          useCase.approved ? 'human' : null,
          numbers,
        ],
      );
    }
    await db.query(
      `UPDATE projects p SET next_usecase_number = greatest(next_usecase_number, coalesce(
         (SELECT max(number) + 1 FROM use_cases WHERE project_id = p.id), 1)) WHERE p.id = $1`,
      [target.projectId],
    );
    return count;
  });
  console.log(`Imported ${String(added)} of ${String(useCases.length)} use cases.`);
} finally {
  await pool.end();
}
