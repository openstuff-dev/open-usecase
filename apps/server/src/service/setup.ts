import { hashPassword, newToken } from '../auth.js';
import type { Role } from '@open-usecase/contracts';
import { withScope, type Client, type Pool } from '../db.js';
import { parseRemote } from '../domain/remote.js';

/**
 * Setting up a team, for the trial's script and the tests. There is no screen for this yet:
 * whether there should be one is a use case of its own.
 */
export async function createTeam(pool: Pool, slug: string, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO teams (slug, name) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, name],
  );
  return rows[0]?.id ?? '';
}

export async function addMember(
  pool: Pool,
  teamId: string,
  input: { email: string; name: string; password: string; role: Role },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [input.email.toLowerCase(), input.name, await hashPassword(input.password)],
  );
  const accountId = rows[0]?.id ?? '';
  await withScope(pool, { teamId }, (db) =>
    db.query(
      `INSERT INTO memberships (team_id, account_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
      [teamId, accountId, input.role],
    ),
  );
  return accountId;
}

export async function createProject(
  pool: Pool,
  teamId: string,
  input: { slug: string; name: string; remote: string; language?: string },
): Promise<string> {
  return withScope(pool, { teamId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO projects (team_id, slug, name, language) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [teamId, input.slug, input.name, input.language ?? 'en'],
    );
    const id = rows[0]?.id ?? '';
    await db.query(
      `INSERT INTO repositories (team_id, project_id, remote_key) VALUES ($1, $2, $3)
       ON CONFLICT (team_id, remote_key) DO UPDATE SET project_id = EXCLUDED.project_id`,
      [teamId, id, parseRemote(input.remote).key],
    );
    return id;
  });
}

/** Stores a new token for an actor. The token itself is returned once, and never again. */
export async function addToken(
  db: Client,
  teamId: string,
  actorId: string,
): Promise<{ id: string; token: string; prefix: string }> {
  const { token, hash, prefix } = newToken();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_tokens (team_id, actor_id, token_hash, prefix) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [teamId, actorId, hash, prefix],
  );
  return { id: rows[0]?.id ?? '', token, prefix };
}

export async function createAgent(
  pool: Pool,
  teamId: string,
  name: string,
): Promise<{ actorId: string; tokenId: string; token: string }> {
  return withScope(pool, { teamId }, async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO actors (team_id, kind, name) VALUES ($1, 'agent', $2) RETURNING id`,
      [teamId, name],
    );
    const actorId = rows[0]?.id ?? '';
    const { id: tokenId, token } = await addToken(db, teamId, actorId);
    return { actorId, tokenId, token };
  });
}
