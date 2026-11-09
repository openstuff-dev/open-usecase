import { fileURLToPath } from 'node:url';
import { verifyUser } from '@openstuff-dev/announce/server';
import { makeConnectionString, type ServerIntegration, vaultFor } from '@openstuff-dev/server';
import { type StandIn, standInOpenAnnounce, standInOpenVersion } from '@openstuff-dev/server/testing';
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

  it('UC-9/S1 UC-9/S2 UC-9/S7 signs an opaque id and the groups for the team, never a name or email', async () => {
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

  // The app above may reach the stand-ins on 127.0.0.1 (fetch: 'private'), as a self-hosted
  // server with OPENUSECASE_FETCH=private would.
  describe('connecting by pasting a connection string', () => {
    const ORIGIN = 'http://localhost:8080';
    const KEY = 'pk_usecase_app_12345678';
    const DEPLOY = 'ov_usecase_deploy_12345678';
    const FEED_KEY = 'pk_usecase_feed_12345678';
    let root = '';
    let ov: StandIn;
    let oa: StandIn;

    const put = (kind: string, connectionString: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/admin/integrations/${kind}`,
        payload: { connectionString },
        headers: { cookie: root },
      });
    const card = (response: { json: () => unknown }) => response.json() as ServerIntegration;

    beforeAll(async () => {
      ov = await standInOpenVersion({ publicKey: KEY, deployToken: DEPLOY });
      oa = await standInOpenAnnounce({ publicKey: FEED_KEY, allowedOrigins: [ORIGIN] });
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM teams WHERE slug = 'acme'");
      await addMember(pool, rows[0].id, {
        email: 'root@acme.test',
        name: 'Root',
        password: 'root-password',
        role: 'admin',
      });
      await pool.query("UPDATE accounts SET is_server_admin = true WHERE email = 'root@acme.test'");
      const session = await app.inject({
        method: 'POST',
        url: '/api/session',
        payload: { email: 'root@acme.test', password: 'root-password' },
      });
      const cookie = session.cookies.find((c) => c.name === 'ou_session');
      if (!cookie) throw new Error('No session for Root');
      root = `ou_session=${cookie.value}`;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM server_integrations');
      await ov.close();
      await oa.close();
    });

    it('UC-7/S6 the page never shows the deploy token again, an export leaves it out, and only a server admin sees the card', async () => {
      const saved = await put(
        'openversion',
        makeConnectionString('openversion', { url: ov.url, publicKey: KEY, deployToken: DEPLOY }),
      );
      expect(card(saved)).toMatchObject({ status: 'connected', hasDeployToken: true });
      const list = await get(root, '/api/admin/integrations');
      expect(list.body).not.toContain(DEPLOY);
      expect((await get(root, '/api/t/acme/export')).body).not.toContain(DEPLOY);
      expect((await get(mia, '/api/admin/integrations')).statusCode).toBe(403);
      expect((await get(null, '/api/admin/integrations')).statusCode).toBe(401);
    });

    it('UC-8/S1 one paste of an OpenAnnounce string connects it, and the web app gets it without a restart', async () => {
      const saved = await put(
        'openannounce',
        makeConnectionString('openannounce', { url: oa.url, publicKey: FEED_KEY, signingSecret: SIGNING }),
      );
      expect(card(saved)).toMatchObject({ status: 'connected', hasSigningSecret: true });
      const client = await get(null, '/api/client-config');
      expect(client.json()).toMatchObject({ openannounce: { url: oa.url, publicKey: FEED_KEY } });
      expect(client.body).not.toContain(SIGNING);
    });

    it('UC-8/S5 the page never shows the signing secret again, an export leaves it out, and only a server admin sees the card', async () => {
      expect((await get(root, '/api/admin/integrations')).body).not.toContain(SIGNING);
      expect((await get(root, '/api/t/acme/export')).body).not.toContain(SIGNING);
      expect((await get(mia, '/api/admin/integrations')).statusCode).toBe(403);
    });

    it('UC-9/S5 switching team signs the groups of the team switched to', async () => {
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM teams WHERE slug = 'beta'");
      await addMember(pool, rows[0].id, {
        email: 'mia@acme.test',
        name: 'Mia',
        password: 'mia-password',
        role: 'admin',
      });
      const groupsIn = async (team: string) => {
        const verified = await verifyUser(SIGNING, (await get(mia, `/api/openannounce-token?team=${team}`)).body);
        if (!verified.ok) throw new Error(verified.error);
        return verified.claims.groups;
      };
      expect(await groupsIn('acme')).toEqual(['t-acme', 'role-member', 't-acme-role-member']);
      expect(await groupsIn('beta')).toEqual(['t-beta', 'role-admin', 't-beta-role-admin']);
    });

    it('UC-8/S2 a key OpenAnnounce doesn’t know, an origin it doesn’t allow, or a string from OpenVersion says what to fix', async () => {
      const unknown = await put(
        'openannounce',
        makeConnectionString('openannounce', { url: oa.url, publicKey: 'pk_unknown_12345678' }),
      );
      expect(card(unknown).message).toContain('OpenAnnounce doesn’t recognise this public key');

      const strict = await standInOpenAnnounce({ publicKey: FEED_KEY, allowedOrigins: ['https://else.example.com'] });
      const blocked = await put(
        'openannounce',
        makeConnectionString('openannounce', { url: strict.url, publicKey: FEED_KEY }),
      );
      await strict.close();
      expect(card(blocked).message).toContain(`Add ${ORIGIN} to allowed origins in OpenAnnounce`);
      expect(card(blocked).copy).toBe(ORIGIN);

      const wrong = await put('openannounce', makeConnectionString('openversion', { url: ov.url, publicKey: KEY }));
      expect(wrong.statusCode).toBe(400);
      expect(wrong.body).toContain('That’s a connection string from OpenVersion. Paste one from OpenAnnounce.');
    });

    it('UC-8/S3 connected with no signing secret, the card says none is saved and nobody gets a token', async () => {
      await pool.query("DELETE FROM server_integrations WHERE kind = 'openannounce'");
      const saved = await put('openannounce', makeConnectionString('openannounce', { url: oa.url, publicKey: FEED_KEY }));
      expect(card(saved)).toMatchObject({ status: 'connected', hasSigningSecret: false });
      expect((await get(mia, '/api/openannounce-token?team=acme')).statusCode).toBe(204);
    });

    it('UC-7/S5 UC-8/S4 a connection the server’s variables set is read-only on the card', async () => {
      const fromEnv = await buildApp(
        {
          ...loadConfig({
            OPENUSECASE_OPENVERSION_URL: 'https://versions.example.com',
            OPENUSECASE_OPENVERSION_PUBLIC_KEY: 'pk_env_version_1234',
            OPENUSECASE_OPENANNOUNCE_URL: 'https://news.example.com',
            OPENUSECASE_OPENANNOUNCE_PUBLIC_KEY: 'pk_env_news_1234',
            OPENUSECASE_OPENANNOUNCE_SIGNING_SECRET: 'sig_env_news_secret',
          }),
          databaseUrl: url,
          logLevel: 'silent',
          secretKey: SECRET_KEY,
        },
        pool,
      );
      try {
        const headers = { cookie: root };
        const list = await fromEnv.inject({ method: 'GET', url: '/api/admin/integrations', headers });
        expect(list.body).not.toContain('sig_env_news_secret');
        for (const kind of ['openversion', 'openannounce']) {
          expect(list.json()).toContainEqual(expect.objectContaining({ kind, status: 'set-by-server' }));
          const save = await fromEnv.inject({
            method: 'PUT',
            url: `/api/admin/integrations/${kind}`,
            headers,
            payload: { url: 'https://other.example.com', publicKey: 'pk_other_12345678' },
          });
          expect(save.statusCode).toBe(409);
        }
      } finally {
        await fromEnv.close();
      }
    });
  });
});
