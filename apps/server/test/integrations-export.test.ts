import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Pool } from '../src/db.js';
import { addMember, createTeam } from '../src/service/setup.js';

// These tests need Postgres: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/openusecase_test.
// The database is emptied first.
const url = process.env.TEST_DATABASE_URL ?? '';

const PUBLIC_KEY = 'pk_export_check_0123456789';
const SEALED_TOKEN = 'sealed-deploy-token-export-check';

describe.skipIf(!url)('a saved server connection stays out of a team export', () => {
  let app: FastifyInstance;
  let pool: Pool;

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.end();
    await migrate(url, fileURLToPath(new URL('../migrations', import.meta.url)));
    pool = createPool(url);
    app = await buildApp(
      { ...loadConfig({}), databaseUrl: url, logLevel: 'silent', secretKey: 'test-secret', fetch: 'private' },
      pool,
    );
    const teamId = await createTeam(pool, 'acme', 'Acme');
    await addMember(pool, teamId, {
      email: 'mia@acme.test',
      name: 'Mia',
      password: 'mia-password',
      role: 'admin',
    });
    await pool.query(
      `INSERT INTO server_integrations (kind, url, public_key, deploy_token_sealed)
       VALUES ('openversion', 'https://versions.example.com', $1, $2)`,
      [PUBLIC_KEY, SEALED_TOKEN],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('leaves the connection, its public key and its sealed deploy token out of the export', async () => {
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'mia@acme.test', password: 'mia-password' },
    });
    expect(signIn.statusCode).toBe(200);
    const cookie = signIn.cookies.find((c) => c.name === 'ou_session');
    expect(cookie).toBeDefined();

    const response = await app.inject({
      method: 'GET',
      url: '/api/t/acme/export',
      headers: { cookie: `ou_session=${cookie?.value ?? ''}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(PUBLIC_KEY);
    expect(response.body).not.toContain(SEALED_TOKEN);
    expect(response.body).not.toContain('versions.example.com');
    expect(response.body).not.toContain('server_integrations');
  });
});
