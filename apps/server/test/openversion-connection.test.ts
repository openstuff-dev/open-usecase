import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import {
  type ConnectionError,
  type FetchPolicy,
  publishOwnVersion,
  publishVersionOnStart,
  type Queryable,
} from '@openstuff-dev/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { integrationOffers } from '../src/integrations.js';

// A stand-in OpenVersion on localhost. Localhost is internal, so the test policy allows it, as a
// self-hosted server with OPENUSECASE_FETCH=private would.
const policy: FetchPolicy = { mode: 'private', allow: [], envPrefix: 'OPENUSECASE' };
const log = { info: () => undefined, warn: () => undefined };
const GOOD = 'ov_live_good_token';
const KEY = 'pk_usecase_12345678';
const context = { policy, origin: 'https://usecase.example.com', userAgent: 'OpenUsecase' };

interface Seen {
  method?: string;
  path?: string;
  auth?: string;
  idempotency?: string;
  body: string;
}
let seen: Seen[] = [];
let answerPublish = 201;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({
        method: request.method,
        path: request.url,
        auth: request.headers.authorization,
        idempotency: request.headers['idempotency-key'] as string | undefined,
        body,
      });
      response.setHeader('content-type', 'application/json');
      // The version API takes the public key; the rest needs the deploy token.
      if (request.url?.startsWith('/api/v1/version')) {
        response.statusCode = request.url.includes(KEY) ? 200 : 401;
        response.end(response.statusCode === 200 ? '{}' : '{"error":"unknown key"}');
        return;
      }
      if (request.headers.authorization !== `Bearer ${GOOD}`) {
        response.statusCode = 401;
        response.end('{"error":"nope"}');
        return;
      }
      response.statusCode = request.method === 'POST' ? answerPublish : 200;
      response.end(request.method === 'POST' ? '{}' : 'null');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  seen = [];
  answerPublish = 201;
});

const [versionOffer] = integrationOffers(loadConfig({}));
const check = (url: string, publicKey: string, deployToken?: string) =>
  versionOffer.kind.check({ url, publicKey, ...(deployToken ? { deployToken } : {}) }, context);
const failure = async (attempt: Promise<unknown>) => {
  try {
    await attempt;
  } catch (error) {
    return (error as ConnectionError).message;
  }
  throw new Error('Expected the check to fail.');
};
const options = { policy, appName: 'OpenUsecase', log };

describe('UC-7 a server admin connects OpenVersion', () => {
  it('UC-7/S1 one paste connects it: a good key and token test as connected', async () => {
    expect(await check(base, KEY, GOOD)).toContain('Connected to OpenVersion.');
    expect(seen.at(-1)).toMatchObject({ path: '/api/v1/releases/live', auth: `Bearer ${GOOD}` });
  });

  it('UC-7/S2 a failed test says that OpenVersion does not recognise the key or the token', async () => {
    expect(await failure(check(base, 'pk_wrong_12345678'))).toContain('doesn’t recognise this public key');
    expect(await failure(check(base, KEY, 'ov_live_wrong'))).toContain('doesn’t recognise this deploy token');
  });

  it('UC-7/S2 an address that does not answer says so', async () => {
    expect(await failure(check('http://127.0.0.1:1', KEY))).toContain('That address didn’t answer.');
  });

  it('UC-7/S2 an internal address is refused under the public policy, with the fix named', async () => {
    const strict: FetchPolicy = { mode: 'public', allow: [], envPrefix: 'OPENUSECASE' };
    const publicOnly = { ...context, policy: strict };
    const attempt = versionOffer.kind.check({ url: base, publicKey: KEY }, publicOnly);
    const message = await failure(attempt);
    expect(message).toContain('OPENUSECASE_FETCH=private');
  });
});

/** Starts OpenUsecase's publish hook with the environment's connection and waits for its call. */
async function startWith(version: string) {
  const config = loadConfig({
    VERSION: version,
    OPENUSECASE_OPENVERSION_URL: base,
    OPENUSECASE_OPENVERSION_PUBLIC_KEY: KEY,
    OPENUSECASE_OPENVERSION_DEPLOY_TOKEN: GOOD,
  });
  const noRows: Queryable = { query: () => Promise.resolve({ rows: [] }) };
  const app = Fastify();
  publishVersionOnStart(app, {
    db: noRows,
    vault: () => Promise.reject(new Error('no saved secrets in this test')),
    offer: integrationOffers(config)[0],
    policy,
    appName: 'OpenUsecase',
    version: config.appVersion,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  for (let i = 0; i < 50 && seen.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await app.close();
}

describe('UC-7 open tabs learn about a new version', () => {
  it('UC-7/S3 starting a newer image publishes its version, keyed by that version', async () => {
    await startWith('1.2.0');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/v1/releases', idempotency: 'openusecase-1.2.0' });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ version: '1.2.0', notes: '' });
  });

  it('UC-7/S4 starting an older image changes nothing: OpenVersion answers 409 and that is fine', async () => {
    answerPublish = 409;
    expect(await publishOwnVersion({ url: base, deployToken: GOOD }, '1.0.0', options)).toBe('not-newer');
  });

  it('UC-7/S7 OpenVersion being down never throws, so starting the server is not affected', async () => {
    const closed = { url: 'http://127.0.0.1:1', deployToken: GOOD };
    expect(await publishOwnVersion(closed, '1.2.0', options)).toBe('failed');
  });

  it('UC-7/S7 a refused deploy token is reported, not thrown', async () => {
    const refused = { url: base, deployToken: 'ov_live_wrong' };
    expect(await publishOwnVersion(refused, '1.2.0', options)).toBe('refused');
  });

  it('UC-7/S8 a build without a version publishes nothing and makes no request', async () => {
    await startWith('');
    expect(seen).toHaveLength(0);
  });
});

describe('UC-7 a server’s configuration wins', () => {
  it('UC-7/S5 the OpenVersion connection is read from the environment', () => {
    const config = loadConfig({
      OPENUSECASE_OPENVERSION_URL: 'https://version.example.com/',
      OPENUSECASE_OPENVERSION_PUBLIC_KEY: 'pk_live_abc',
      OPENUSECASE_OPENVERSION_DEPLOY_TOKEN: 'ov_live_secret',
      VERSION: '1.2.0',
    });
    const [version] = integrationOffers(config);
    expect(version.environment).toEqual({
      url: 'https://version.example.com',
      publicKey: 'pk_live_abc',
      deployToken: 'ov_live_secret',
    });
    expect(version.deployToken).toBe(true);
    expect(config.appVersion).toBe('1.2.0');
  });

  it('UC-7/S8 with no version set, the image reports unknown', () => {
    expect(loadConfig({}).appVersion).toBe('unknown');
  });
});
