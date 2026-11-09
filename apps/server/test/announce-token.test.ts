import { fileURLToPath } from 'node:url';
import { verifyUser } from '@openstuff-dev/announce/server';
import { vaultFor } from '@openstuff-dev/server';
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
const SECRET_KEY = 'test-secret';
const SIGNING = 'sig_usecase_token_secret_93ab1c';

describe.skipIf(!url)('UC-8 and UC-9 the OpenAnnounce token', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let mia = '';

  const get = (cookie: string | null, path: string) =>
    app.inject({ method: 'GET', url: path, headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.end();
    await migrate(url, fileURLToPath(new URL('../migrations', import.meta.url)));
    pool = createPool(url);
    app = await buildApp(
      { ...loadConfig({}), databaseUrl: url, logLevel: 'silent', secretKey: SECRET_KEY, fetch: 'private' },
      pool,
    );
    const acme = await createTeam(pool, 'acme', 'Acme');
    await createTeam(pool, 'beta', 'Beta');
    await addMember(pool, acme, { email: 'mia@acme.test', name: 'Mia', password: 'mia-password', role: 'member' });
    const session = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { email: 'mia@acme.test', password: 'mia-password' },
    });
    const cookie = session.cookies.find((c) => c.name === 'ou_session');
    if (!cookie) throw new Error('No session for Mia');
    mia = `ou_session=${cookie.value}`;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('UC-9/S1 S2 S7 signs an opaque id and the groups for the team, never a name or email', async () => {
    await pool.query(
      `INSERT INTO server_integrations (kind, url, public_key, signing_secret_encrypted)
       VALUES ('openannounce', 'https://news.example.com', 'pk_news_token_12345678', $1)`,
      [vaultFor(SECRET_KEY).seal(SIGNING)],
    );
    try {
      const response = await get(mia, '/api/openannounce-token?team=acme');
      expect(response.statusCode).toBe(200);
      const verified = await verifyUser(SIGNING, response.body);
      if (!verified.ok) throw new Error(verified.error);
      expect(verified.claims.groups).toEqual(['t-acme', 'role-member', 't-acme-role-member']);
      expect(JSON.stringify(verified.claims)).not.toContain('mia@acme.test');
      expect(JSON.stringify(verified.claims)).not.toContain('Mia');

      expect((await get(mia, '/api/openannounce-token?team=beta')).statusCode).toBe(404);
      expect((await get(null, '/api/openannounce-token')).statusCode).toBe(401);
    } finally {
      await pool.query("DELETE FROM server_integrations WHERE kind = 'openannounce'");
    }
  });

  it('UC-8/S6 gives no OpenAnnounce token once the connection is removed', async () => {
    expect((await get(mia, '/api/openannounce-token?team=acme')).statusCode).toBe(204);
  });
});
