import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Pool } from '../src/db.js';
import { addMember, createAgent, createTeam } from '../src/service/setup.js';

// These tests need Postgres: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/openusecase_test.
// The database is emptied first.
const url = process.env.TEST_DATABASE_URL ?? '';

describe.skipIf(!url)('UC-5 a member changes their password', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let acmeId = '';

  const http = (
    cookie: string | undefined,
    method: string,
    path: string,
    payload?: object,
    token?: string,
  ) =>
    app.inject({
      method: method as 'GET',
      url: path,
      ...(payload ? { payload } : {}),
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });

  async function signIn(password: string, email = 'mia@acme.test'): Promise<string | null> {
    const response = await http(undefined, 'POST', '/api/session', { email, password });
    if (response.statusCode !== 200) return null;
    const cookie = response.cookies.find((c) => c.name === 'ou_session');
    return cookie ? `ou_session=${cookie.value}` : null;
  }

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
    acmeId = await createTeam(pool, 'acme', 'Acme');
    await addMember(pool, acmeId, {
      email: 'mia@acme.test',
      name: 'Mia',
      password: 'mia-password',
      role: 'member',
    });
    await createAgent(pool, acmeId, 'Claude');
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('UC-5/S1 a member changes the password, and the new one signs in while the old one stops', async () => {
    const cookie = await signIn('mia-password');
    expect(cookie).not.toBeNull();
    const changed = await http(cookie ?? '', 'PUT', '/api/me/password', {
      current: 'mia-password',
      next: 'mia-new-password',
    });
    expect(changed.statusCode).toBe(200);
    expect(await signIn('mia-new-password')).not.toBeNull();
    expect(await signIn('mia-password')).toBeNull();
  });

  it('UC-5/S2 a wrong current password is refused and the password stays', async () => {
    const cookie = await signIn('mia-new-password');
    const refused = await http(cookie ?? '', 'PUT', '/api/me/password', {
      current: 'not-my-password',
      next: 'another-password',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('Your current password isn’t right.');
    expect(await signIn('mia-new-password')).not.toBeNull();
  });

  it('UC-5/S3 a new password under 10 characters is refused', async () => {
    const cookie = await signIn('mia-new-password');
    const refused = await http(cookie ?? '', 'PUT', '/api/me/password', {
      current: 'mia-new-password',
      next: 'short',
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('at least 10 characters');
    expect(await signIn('mia-new-password')).not.toBeNull();
  });

  it('UC-5/S4 changing it signs out the other devices and keeps this one', async () => {
    const here = await signIn('mia-new-password');
    const other = await signIn('mia-new-password');
    expect(here).not.toBeNull();
    expect(other).not.toBeNull();
    const changed = await http(here ?? '', 'PUT', '/api/me/password', {
      current: 'mia-new-password',
      next: 'mia-third-password',
    });
    expect(changed.statusCode).toBe(200);
    expect((await http(here ?? '', 'GET', '/api/me')).statusCode).toBe(200);
    expect((await http(other ?? '', 'GET', '/api/me')).statusCode).toBe(401);
  });

  it('UC-5/S5 an agent token is refused', async () => {
    const agent = await createAgent(pool, acmeId, 'Second agent');
    const refused = await http(undefined, 'PUT', '/api/me/password', {
      current: 'anything',
      next: 'another-password',
    }, agent.token);
    expect(refused.statusCode).toBe(403);
  });
});
