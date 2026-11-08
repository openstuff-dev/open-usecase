import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { FetchPolicy } from '@openstuff-dev/server';
import { publishOwnVersion, testOpenVersion } from '../src/service/openversion.js';

// A stand-in OpenVersion on localhost. Localhost is internal, so the test policy allows it, as a
// self-hosted server with OPENUSECASE_FETCH=private would.
const policy: FetchPolicy = {
  mode: 'private',
  allow: ['127.0.0.1', 'localhost'],
  envPrefix: 'OPENUSECASE',
};
// The publish logs through the server's logger; the test only needs the methods it calls.
const log = { info: () => undefined, warn: () => undefined } as unknown as FastifyBaseLogger;
const GOOD = 'ov_live_good_token';

interface Seen {
  method?: string;
  path?: string;
  auth?: string;
  idempotency?: string;
  body?: string;
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
      const authorised = request.headers.authorization === `Bearer ${GOOD}`;
      if (!authorised) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"error":"nope"}');
        return;
      }
      if (request.method === 'POST') {
        response.writeHead(answerPublish, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('null');
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

describe('UC-7 a server admin connects OpenVersion', () => {
  it('UC-7/S1 one paste connects it: a good token tests as connected', async () => {
    const answer = await testOpenVersion(policy, base, GOOD);
    expect(answer.ok).toBe(true);
    expect(answer.message).toContain('Connected');
    expect(seen.at(-1)?.path).toBe('/api/v1/releases/live');
    expect(seen.at(-1)?.auth).toBe(`Bearer ${GOOD}`);
  });

  it('UC-7/S2 a failed test says that OpenVersion does not recognise the token', async () => {
    const answer = await testOpenVersion(policy, base, 'ov_live_wrong');
    expect(answer.ok).toBe(false);
    expect(answer.message).toBe('OpenVersion doesn’t recognise this deploy token.');
  });

  it('UC-7/S2 an address that does not answer says so', async () => {
    const answer = await testOpenVersion(policy, 'http://127.0.0.1:1', GOOD);
    expect(answer).toEqual({ ok: false, message: 'That address didn’t answer.' });
  });

  it('UC-7/S2 an internal address is refused under the public policy, with the fix named', async () => {
    const answer = await testOpenVersion({ mode: 'public', allow: [], envPrefix: 'OPENUSECASE' }, base, GOOD);
    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('OPENUSECASE_FETCH=private');
  });
});

describe('UC-7 open tabs learn about a new version', () => {
  it('UC-7/S3 starting a newer image publishes its version, keyed by that version', async () => {
    seen = [];
    answerPublish = 201;
    const outcome = await publishOwnVersion(policy, { url: base, deployToken: GOOD }, '1.2.0', log);
    expect(outcome).toBe('published');
    const post = seen.find((s) => s.method === 'POST');
    expect(post?.path).toBe('/api/v1/releases');
    expect(post?.idempotency).toBe('openusecase-1.2.0');
    expect(JSON.parse(post?.body ?? '{}')).toEqual({ version: '1.2.0', notes: '' });
  });

  it('UC-7/S4 starting an older image changes nothing: OpenVersion answers 409 and that is fine', async () => {
    answerPublish = 409;
    const outcome = await publishOwnVersion(policy, { url: base, deployToken: GOOD }, '1.0.0', log);
    expect(outcome).toBe('not-newer');
  });

  it('UC-7/S7 OpenVersion being down never throws, so starting the server is not affected', async () => {
    const outcome = await publishOwnVersion(policy, { url: 'http://127.0.0.1:1', deployToken: GOOD }, '1.2.0', log);
    expect(outcome).toBe('failed');
  });

  it('UC-7/S7 a refused deploy token is reported, not thrown', async () => {
    const outcome = await publishOwnVersion(policy, { url: base, deployToken: 'ov_live_wrong' }, '1.2.0', log);
    expect(outcome).toBe('refused');
  });

  it('UC-7/S8 a build without a version publishes nothing and makes no request', async () => {
    seen = [];
    const outcome = await publishOwnVersion(policy, { url: base, deployToken: GOOD }, '0.0.0', log);
    expect(outcome).toBe('skipped');
    expect(seen).toHaveLength(0);
  });
});

describe('UC-7 a server’s configuration wins', () => {
  it('UC-7/S5 the OpenVersion connection is read from the environment', () => {
    const config = loadConfig({
      OPENUSECASE_OPENVERSION_URL: 'https://version.example.com/',
      OPENUSECASE_OPENVERSION_PUBLIC_KEY: 'pk_live_abc',
      OPENUSECASE_OPENVERSION_DEPLOY_TOKEN: 'ov_live_secret',
      OPENUSECASE_VERSION: '1.2.0',
    });
    expect(config.openVersion).toEqual({
      url: 'https://version.example.com',
      publicKey: 'pk_live_abc',
      deployToken: 'ov_live_secret',
    });
    expect(config.version).toBe('1.2.0');
  });

  it('UC-7/S8 with no version set, the image reports 0.0.0', () => {
    expect(loadConfig({}).version).toBe('0.0.0');
  });
});
