// Trial tooling: makes a team, a project and an agent, and prints the agent's token once.
//
//   npm run -w apps/server trial:setup -- --team acme --project demo \
//     --remote https://github.com/acme/demo.git --agent claude
//
// Then sign in as the first admin, who sees every team.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createAgent, createProject, createTeam } from './service/setup.js';

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    project: { type: 'string' },
    remote: { type: 'string' },
    agent: { type: 'string', default: 'agent' },
  },
});
const { team, project, remote, agent } = values;
if (!team || !project || !remote) {
  throw new Error('Usage: trial:setup --team <slug> --project <slug> --remote <git url> [--agent <name>]');
}

const config = loadConfig();
await migrate(config.databaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)));
const pool = createPool(config.databaseUrl);
try {
  const teamId = await createTeam(pool, team, team);
  await createProject(pool, teamId, { slug: project, name: project, remote });
  const { token } = await createAgent(pool, teamId, agent);
  console.log(`Team "${team}", project "${project}", agent "${agent}".`);
  console.log(`Token, shown once: ${token}`);
} finally {
  await pool.end();
}
