import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  Catalogue,
  Glossary,
  Inbox,
  InboxItem,
  TeamExport,
  TeamSettings,
  UseCaseDetail,
} from '@open-usecase/contracts';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Pool, withScope } from '../src/db.js';
import { addMember, createAgent, createProject, createTeam } from '../src/service/setup.js';
import { testLink } from '../src/service/glossary.js';
import { type CheckAnswer, uploadReport } from '../src/service/reports.js';

// These tests need Postgres: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/openusecase_test.
// The database is emptied first. Agents connect over real HTTP, with the real MCP client.
const url = process.env.TEST_DATABASE_URL ?? '';

const REMOTE_A = 'https://github.com/acme/shop.git';
const REMOTE_B = 'git@github.com:bravo/shop.git';
const GHERKIN = `Feature: Change the colour

  Scenario: Change it
    When I change the primary colour
    Then the app uses the new colour

  Scenario: Refuse a bad colour
    When I enter a value that isn't a colour
    Then I see an error
`;

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected a ${what}.`);
  return value;
}

describe.skipIf(!url)('the trial against Postgres', () => {
  let app: FastifyInstance;
  let pool: Pool;
  let base: string;
  let memberA: string;
  let adminA: string;
  let memberB: string;
  let agentA: { actorId: string; tokenId: string; token: string };
  let agentA2: { actorId: string; tokenId: string; token: string };
  let agentB: { actorId: string; tokenId: string; token: string };
  const clients: Client[] = [];

  const http = (
    who: { cookie?: string; token?: string },
    method: string,
    path: string,
    payload?: object,
  ) =>
    app.inject({
      method: method as 'GET',
      url: path,
      ...(payload ? { payload } : {}),
      headers: {
        ...(who.cookie ? { cookie: who.cookie } : {}),
        ...(who.token ? { authorization: `Bearer ${who.token}` } : {}),
      },
    });

  async function signIn(email: string, password: string): Promise<string> {
    const response = await http({}, 'POST', '/api/session', { email, password });
    expect(response.statusCode).toBe(200);
    const cookie = must(response.cookies.find((c) => c.name === 'ou_session'), 'session cookie');
    return `ou_session=${cookie.value}`;
  }

  async function agent(token: string): Promise<Client> {
    const client = new Client({ name: 'test-agent', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function call(token: string, name: string, args: Record<string, unknown>) {
    const result = await (await agent(token)).callTool({ name, arguments: args });
    const content = result.content as { text: string }[];
    return { text: content[0]?.text ?? '', isError: result.isError === true };
  }

  const inbox = async (cookie: string, team = 'acme') =>
    (await http({ cookie }, 'GET', `/api/t/${team}/inbox`)).json<Inbox>().items;
  const inboxItem = async (ref: string, cookie = memberA, team = 'acme'): Promise<InboxItem> =>
    must((await inbox(cookie, team)).find((i) => i.ref === ref), `${ref} in the inbox`);

  /** Proposes as agent A and returns its ID, e.g. UC-3. */
  async function propose(gherkin = GHERKIN, token = agentA.token, remote = REMOTE_A) {
    const { text, isError } = await call(token, 'propose_usecase', {
      remote,
      title: 'Change the colour',
      gherkin,
      original_request: 'Let me change the colour',
    });
    expect(isError, text).toBe(false);
    return must(/UC-\d+/.exec(text)?.[0], 'use case ID');
  }

  const useCaseCount = () =>
    withScope(pool, { bypass: true }, async (db) =>
      Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM use_cases')).rows[0]?.n),
    );

  beforeAll(async () => {
    const owner = new pg.Client({ connectionString: url });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.end();
    await migrate(url, fileURLToPath(new URL('../migrations', import.meta.url)));
    pool = createPool(url);
    app = await buildApp(
      {
        ...loadConfig({}),
        databaseUrl: url,
        logLevel: 'silent',
        secretKey: 'test-secret',
        fetch: 'private',
      },
      pool,
    );
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = must(app.addresses()[0], 'address');
    base = `http://127.0.0.1:${String(address.port)}`;

    const a = await createTeam(pool, 'acme', 'Acme');
    const b = await createTeam(pool, 'bravo', 'Bravo');
    await createProject(pool, a, { slug: 'shop', name: 'Shop', remote: REMOTE_A });
    await createProject(pool, b, { slug: 'shop', name: 'Shop', remote: REMOTE_B });
    await addMember(pool, a, { email: 'mia@acme.test', name: 'Mia', password: 'mia-password', role: 'member' });
    await addMember(pool, a, { email: 'ada@acme.test', name: 'Ada', password: 'ada-password', role: 'admin' });
    await addMember(pool, b, { email: 'bo@bravo.test', name: 'Bo', password: 'bo-password', role: 'member' });
    await pool.query(
      `INSERT INTO accounts (email, name, password_hash, is_server_admin)
       VALUES ('root@server.test', 'Root', $1, true)`,
      [await hashPassword('root-password')],
    );
    agentA = await createAgent(pool, a, 'Agent A');
    agentA2 = await createAgent(pool, a, 'Agent A2');
    agentB = await createAgent(pool, b, 'Agent B');
    memberA = await signIn('mia@acme.test', 'mia-password');
    adminA = await signIn('ada@acme.test', 'ada-password');
    memberB = await signIn('bo@bravo.test', 'bo-password');
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await app.close();
    await pool.end();
  });

  describe('TUC-1: an agent proposes a use case', () => {
    it('TUC-1/S1 a valid proposal returns its IDs, is proposed and reaches the inbox', async () => {
      const { text, isError } = await call(agentA.token, 'propose_usecase', {
        remote: REMOTE_A,
        title: 'Change the colour',
        gherkin: GHERKIN,
        original_request: 'Let me change the colour',
      });
      expect(isError).toBe(false);
      const ref = must(/UC-\d+/.exec(text)?.[0]);
      expect(text).toContain(`${ref}/S1: Change it`);
      expect(text).toContain(`${ref}/S2: Refuse a bad colour`);
      expect(text).toContain('Status: proposed');

      const item = await inboxItem(ref);
      expect(item).toMatchObject({
        title: 'Change the colour',
        proposedBy: 'Agent A',
        originalRequest: 'Let me change the colour',
        project: { slug: 'shop' },
      });
      expect(item.scenarios.map((s) => s.number)).toEqual([1, 2]);
      expect(item.preamble).toEqual([
        { kind: 'heading', keyword: 'Feature', text: 'Change the colour' },
      ]);
      expect(item.scenarios[0]?.name).toBe('Change it');
      expect(item.scenarios[0]?.blocks).toMatchObject([
        { kind: 'step', phase: 'when', text: 'I change the primary colour' },
        { kind: 'step', phase: 'then', text: 'the app uses the new colour' },
      ]);
    });

    it('TUC-1/S2 Gherkin that does not parse is refused with a reason, and nothing arrives', async () => {
      const before = await useCaseCount();
      const { text, isError } = await call(agentA.token, 'propose_usecase', {
        remote: REMOTE_A,
        title: 'Broken',
        gherkin: 'Feature: X\n  Scenario: Y\n    Given a\n  Bad line',
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/doesn't parse.*\(4:3\)/s);
      expect(await useCaseCount()).toBe(before);
      expect((await inbox(memberA)).some((i) => i.title === 'Broken')).toBe(false);
    });

    it('TUC-1/S2 a refused proposal does not use up a use case number', async () => {
      const first = Number((await propose()).slice(3));
      await call(agentA.token, 'propose_usecase', { remote: REMOTE_A, title: 'Broken', gherkin: 'nope' });
      expect(Number((await propose()).slice(3))).toBe(first + 1);
    });

    it.each([
      ['no token', undefined],
      ['an unknown token', 'uc_not-a-real-token'],
    ])('TUC-1/S3 a proposal with %s is refused, and nothing arrives', async (_name, token) => {
      const before = await useCaseCount();
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'propose_usecase',
            arguments: { remote: REMOTE_A, title: 'Sneaky', gherkin: GHERKIN },
          },
        }),
      });
      expect(response.status).toBe(401);
      expect(await useCaseCount()).toBe(before);
    });

    it('TUC-1/S3 a revoked token is refused', async () => {
      const temp = await createAgent(pool, must((await withScope(pool, { bypass: true }, (db) => db.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`))).rows[0]).id, 'Temp');
      await expect(agent(temp.token)).resolves.toBeDefined();
      const revoked = await http({ cookie: adminA }, 'DELETE', `/api/t/acme/tokens/${temp.tokenId}`);
      expect(revoked.statusCode).toBe(200);
      await expect(agent(temp.token)).rejects.toThrow();
    });
  });

  describe('TUC-2: a person reviews a proposal', () => {
    it('TUC-2/S1 a reviewer sees everything they approve, not only names and steps', async () => {
      const ref = await propose(`Feature: Colours
  Only admins can change colours.

  Background:
    Given I am an admin

  Scenario Outline: Pick a colour
    This is about the settings page.
    When I pick <colour>
    Then the app uses:
      | part   |
      | header |

    Examples:
      | colour |
      | red    |
`);
      const item = await inboxItem(ref);
      const preamble = JSON.stringify(item.preamble);
      expect(preamble).toContain('Only admins can change colours.');
      expect(preamble).toContain('I am an admin');
      const text = JSON.stringify(must(item.scenarios[0]).blocks);
      expect(text).toContain('This is about the settings page.');
      expect(text).toContain('header');
      expect(text).toContain('red');
    });

    it('TUC-2/S1 a member approves a proposal, and it leaves the inbox', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      const response = await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: 'approved' });
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);

      const { rows } = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ approval_method: string; decided_by: string | null }>(
          'SELECT approval_method, decided_by FROM revisions WHERE use_case_id = $1',
          [id],
        ),
      );
      expect(rows[0]?.approval_method).toBe('human');
      expect(rows[0]?.decided_by).toBeTruthy();
    });

    it('TUC-2/S1 approving twice does not decide twice', async () => {
      const { id } = await inboxItem(await propose());
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      const again = await http({ cookie: adminA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      expect(again.statusCode).toBe(409);
    });

    it('TUC-2/S1 an agent cannot approve, not even its own proposal', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      const response = await http({ token: agentA.token }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      expect(response.statusCode).toBe(403);
      expect((await inboxItem(ref)).id).toBe(id);
    });

    it('TUC-2/S2 a member comments on a scenario and asks for changes', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      const comment = await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/comments`, {
        scenario: 2,
        body: 'What does the error say?',
      });
      expect(comment.statusCode).toBe(201);
      expect((await inboxItem(ref)).comments).toMatchObject([
        { scenario: 2, body: 'What does the error say?', author: 'Mia', revision: 1 },
      ]);
      const response = await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/request-changes`, {
        changes: 'Name the error.',
      });
      expect(response.json()).toEqual({ status: 'changes_requested' });
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
    });

    it('TUC-9/S4 asking for changes without saying what is refused, and changes nothing', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/comments`, {
        scenario: 1,
        body: 'A comment alone is not enough.',
      });
      for (const payload of [{}, { changes: '   ' }]) {
        const response = await http(
          { cookie: memberA },
          'POST',
          `/api/t/acme/usecases/${id}/request-changes`,
          payload,
        );
        expect(response.statusCode).toBe(400);
      }
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(true);
    });

    it('TUC-9/S4 what the person typed reaches the use case, next to their comments', async () => {
      const { ref, id } = await changesRequested();
      const { rows } = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ scenario_number: number | null; body: string }>(
          'SELECT scenario_number, body FROM comments WHERE use_case_id = $1 ORDER BY created_at',
          [id],
        ),
      );
      expect(rows).toEqual([
        { scenario_number: 1, body: 'Say which colours work.' },
        { scenario_number: null, body: 'Be specific.' },
      ]);
      expect(ref).toMatch(/^UC-/);
    });

    it('TUC-2/S2 a comment on a scenario the use case does not have is refused', async () => {
      const { id } = await inboxItem(await propose());
      const response = await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/comments`, {
        scenario: 99,
        body: 'Hm',
      });
      expect(response.statusCode).toBe(404);
    });

    async function changesRequested() {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/comments`, {
        scenario: 1,
        body: 'Say which colours work.',
      });
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/request-changes`, {
        changes: 'Be specific.',
      });
      return { ref, id };
    }

    it('TUC-2/S3 the agent revises: proposed again, new text in the inbox, comments kept', async () => {
      const { ref, id } = await changesRequested();
      const gherkin = `Feature: Change the colour

  @S1
  Scenario: Change it to any hex colour
    When I change the primary colour to a hex value
    Then the app uses the new colour

  Scenario: Something new
    When I reset the colour
    Then the app uses the default colour
`;
      const { text, isError } = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        gherkin,
        what_changed: 'Said which colours work.',
      });
      expect(isError, text).toBe(false);
      expect(text).toContain('Status: proposed');

      const item = await inboxItem(ref);
      expect(item.id).toBe(id);
      expect(item.revision).toBe(2);
      expect(item.whatChanged).toBe('Said which colours work.');
      expect(item.originalRequest).toBe('Let me change the colour');
      // S2 was dropped, so the new scenario is S3: numbers are never reused.
      expect(item.scenarios.map((s) => [s.number, s.name])).toEqual([
        [1, 'Change it to any hex colour'],
        [3, 'Something new'],
      ]);
      expect(item.comments).toMatchObject([
        { scenario: 1, body: 'Say which colours work.', revision: 1 },
        { scenario: null, body: 'Be specific.', revision: 1 },
      ]);
    });

    it('TUC-2/S3 a different agent cannot revise it', async () => {
      const { ref } = await changesRequested();
      const { text, isError } = await call(agentA2.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        gherkin: GHERKIN,
        what_changed: 'Mine now.',
      });
      expect(isError).toBe(true);
      expect(text).toContain('Only the agent that proposed');
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
    });

    it('TUC-2/S3 a proposal still waiting for review cannot be revised', async () => {
      const ref = await propose();
      const { isError, text } = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        gherkin: GHERKIN,
        what_changed: 'Early.',
      });
      expect(isError).toBe(true);
      expect(text).toContain('only when changes are requested');
    });

    it('TUC-2/S3 a revision with a tag this use case never had is refused', async () => {
      const { ref } = await changesRequested();
      const { isError, text } = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        gherkin: 'Feature: X\n  @S42\n  Scenario: Y\n    Given a',
        what_changed: 'Bad tag.',
      });
      expect(isError).toBe(true);
      expect(text).toContain('@S42');
    });

    it('TUC-2/S3 the agent can reply to a comment, on a scenario', async () => {
      const ref = await propose();
      const { isError } = await call(agentA.token, 'comment_on_usecase', {
        remote: REMOTE_A,
        id: ref,
        scenario: 1,
        body: 'I read this as any CSS colour.',
      });
      expect(isError).toBe(false);
      expect((await inboxItem(ref)).comments).toMatchObject([
        { scenario: 1, author: 'Agent A', body: 'I read this as any CSS colour.' },
      ]);
    });
  });

  describe('TUC-3: teams and permissions stay apart', () => {
    it("TUC-3/S1 a member's inbox has only their own team", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      expect((await inboxItem(ref, memberB, 'bravo')).proposedBy).toBe('Agent B');
      expect((await inbox(memberA)).every((i) => i.proposedBy !== 'Agent B')).toBe(true);
    });

    it("TUC-3/S1 asking for another team's inbox directly reads as not found", async () => {
      await propose(GHERKIN, agentB.token, REMOTE_B);
      expect((await http({ cookie: memberA }, 'GET', '/api/t/bravo/inbox')).statusCode).toBe(404);
      expect((await http({ cookie: memberA }, 'GET', '/api/t/nobody/inbox')).statusCode).toBe(404);
    });

    it("TUC-3/S1 row-level security hides another team's rows even without a WHERE", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      const bravo = await inboxItem(ref, memberB, 'bravo');
      const acmeId = must(
        (await withScope(pool, { bypass: true }, (db) => db.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`))).rows[0],
      ).id;
      const ids = await withScope(pool, { teamId: acmeId }, async (db) => {
        const seen: string[] = [];
        for (const table of ['use_cases', 'revisions', 'projects', 'repositories', 'actors', 'api_tokens', 'memberships', 'scenarios', 'comments']) {
          const { rows } = await db.query<{ team_id: string }>(`SELECT team_id FROM ${table}`);
          seen.push(...rows.map((r) => r.team_id));
        }
        const direct = await db.query('SELECT 1 FROM use_cases WHERE id = $1', [bravo.id]);
        expect(direct.rowCount).toBe(0);
        return new Set(seen);
      });
      expect([...ids]).toEqual([acmeId]);
      // Unscoped, the app's connection sees no team's rows at all.
      expect((await pool.query('SELECT 1 FROM use_cases')).rowCount).toBe(0);
    });

    it("TUC-3/S1 a member can't act on another team's use case through their own team", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      const { id } = await inboxItem(ref, memberB, 'bravo');
      for (const path of [`/api/t/acme/usecases/${id}/approve`, `/api/t/bravo/usecases/${id}/approve`]) {
        expect((await http({ cookie: memberA }, 'POST', path)).statusCode).toBe(404);
      }
      expect((await inboxItem(ref, memberB, 'bravo')).id).toBe(id);
    });

    it("TUC-3/S2 an agent told about another team's use case is told it wasn't found", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      const before = await inboxItem(ref, memberB, 'bravo');
      const revise = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_B,
        id: ref,
        gherkin: GHERKIN,
        what_changed: 'Not mine.',
      });
      const comment = await call(agentA.token, 'comment_on_usecase', {
        remote: REMOTE_B,
        id: ref,
        body: 'Not mine.',
      });
      for (const result of [revise, comment]) {
        expect(result.isError).toBe(true);
        expect(result.text).toBe(`${ref} wasn't found.`);
      }
      expect(await inboxItem(ref, memberB, 'bravo')).toEqual(before);
    });

    it('TUC-3/S2 two teams can have the same remote and still stay apart', async () => {
      const bravoId = must(
        (await withScope(pool, { bypass: true }, (db) => db.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'bravo'`))).rows[0],
      ).id;
      const shared = 'https://github.com/open/shared.git';
      const acmeId = must(
        (await withScope(pool, { bypass: true }, (db) => db.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`))).rows[0],
      ).id;
      await createProject(pool, bravoId, { slug: 'shared', name: 'Shared', remote: shared });
      await createProject(pool, acmeId, { slug: 'shared', name: 'Shared', remote: shared });
      const inBravo = await propose(GHERKIN, agentB.token, shared);
      const comment = await call(agentA.token, 'comment_on_usecase', { remote: shared, id: inBravo, body: 'Hi' });
      expect(comment.text).toBe(`${inBravo} wasn't found.`);
    });

    it('TUC-3/S3 an agent gets a 403 for every token and permission change, even its own', async () => {
      const who = { token: agentA.token };
      const attempts = [
        await http(who, 'POST', `/api/t/acme/actors/${agentA.actorId}/tokens`),
        await http(who, 'POST', `/api/t/acme/actors/${agentA2.actorId}/tokens`),
        await http(who, 'DELETE', `/api/t/acme/tokens/${agentA.tokenId}`),
        await http(who, 'DELETE', `/api/t/acme/tokens/${agentA2.tokenId}`),
        await http(who, 'PATCH', `/api/t/acme/actors/${agentA.actorId}`, { review: 'auto_approve' }),
        await http(who, 'PATCH', `/api/t/acme/actors/${agentA.actorId}`, { canReview: true }),
        // Another team, and a token next to a person's session, get the same answer.
        await http(who, 'POST', `/api/t/bravo/actors/${agentB.actorId}/tokens`),
        await http({ token: agentA.token, cookie: adminA }, 'PATCH', `/api/t/acme/actors/${agentA.actorId}`, { review: 'auto_approve' }),
      ];
      expect(attempts.map((r) => r.statusCode)).toEqual(attempts.map(() => 403));

      const { rows } = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ review: string; can_review: boolean; tokens: string; live: string }>(
          `SELECT a.review, a.can_review,
                  (SELECT count(*) FROM api_tokens t WHERE t.actor_id = a.id) AS tokens,
                  (SELECT count(*) FROM api_tokens t WHERE t.actor_id = a.id AND t.revoked_at IS NULL) AS live
             FROM actors a WHERE a.id = $1`,
          [agentA.actorId],
        ),
      );
      expect(rows[0]).toEqual({ review: 'human_approval', can_review: false, tokens: '1', live: '1' });
      await expect(agent(agentA.token)).resolves.toBeDefined();
    });

    it('TUC-3/S3 MCP offers an agent no way to manage tokens or permissions', async () => {
      const { tools } = await (await agent(agentA.token)).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'claim_done',
        'comment_on_usecase',
        'get_usecase',
        'list_areas',
        'list_without_evidence',
        'propose_usecase',
        'request_retirement',
        'revise_usecase',
        'search_usecases',
      ]);
    });

    it("TUC-3/S3 a person who isn't an admin gets a 403 too, and an admin may", async () => {
      const path = `/api/t/acme/actors/${agentA2.actorId}`;
      expect((await http({ cookie: memberA }, 'PATCH', path, { canReview: true })).statusCode).toBe(403);
      expect((await http({ cookie: adminA }, 'PATCH', path, { canReview: true })).statusCode).toBe(200);
      const made = await http({ cookie: adminA }, 'POST', `${path}/tokens`);
      expect(made.statusCode).toBe(201);
      expect(made.json<{ token: string }>().token).toMatch(/^uc_/);
    });
  });

  describe('TUC-4: an agent reads a use case', () => {
    const get = (ref: string, token = agentA.token, remote = REMOTE_A) =>
      call(token, 'get_usecase', { remote, id: ref });
    const approve = async (ref: string) => {
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
    };

    it('TUC-4/S1 an approved use case gives its status and text, and says it is ready', async () => {
      const ref = await propose();
      await approve(ref);
      const { text, isError } = await get(ref);
      expect(isError).toBe(false);
      expect(text).toContain('Status: approved.');
      expect(text).toContain('It is ready to build, if it is not built yet.');
      expect(text).toContain('Scenario: Change it');
      expect(text).toContain('@S1');
    });

    it('TUC-4/S2 a use case still waiting gives its text, and says clearly not to build', async () => {
      const ref = await propose();
      const { text } = await get(ref);
      expect(text).toContain('Status: proposed.');
      expect(text).toContain('Do not build it yet.');
      expect(text).toContain('Scenario: Change it');
      expect(text).not.toContain('ready to build');
    });

    it('TUC-4/S3 after a change request it says to revise first, with each comment and its scenario', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/comments`, {
        scenario: 2,
        body: 'What does the error say?',
      });
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/request-changes`, {
        changes: 'Name the colours too.',
      });
      const { text } = await get(ref);
      expect(text).toContain('Status: changes_requested.');
      expect(text).toContain('Do not build it.');
      expect(text).toContain(`Revise ${ref} first`);
      expect(text).toContain(`On ${ref}/S2, by Mia (revision 1): What does the error say?`);
      expect(text).toContain('On the whole use case, by Mia (revision 1): Name the colours too.');
      expect(text).not.toContain('ready to build');
    });

    it('TUC-4/S3 an agent reads the text of the newest revision after revising', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/request-changes`, {
        changes: 'Rename it.',
      });
      await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Renamed it.',
        gherkin: 'Feature: Renamed\n\n  @S1\n  Scenario: Renamed scenario\n    Given a\n',
      });
      const { text } = await get(ref);
      expect(text).toContain('Revision 2.');
      expect(text).toContain('Scenario: Renamed scenario');
      expect(text).not.toContain('Scenario: Change it');
    });

    it('TUC-4/S1 a use case that does not exist reads as not found', async () => {
      expect(await get('UC-999999')).toMatchObject({ isError: true, text: "UC-999999 wasn't found." });
      expect(await get('nonsense')).toMatchObject({ isError: true });
    });

    it('TUC-4/S4 search finds use cases by their words, each with its ID and status', async () => {
      const word = `zebra${String(Date.now())}`;
      const gherkin = `Feature: Stripes\n\n  Scenario: Show the ${word}s\n    When I look\n    Then I see them\n`;
      const waiting = await propose(gherkin);
      const decided = await propose(gherkin);
      await approve(decided);
      await propose();

      const { text } = await call(agentA.token, 'search_usecases', { query: word });
      expect(text).toContain(`${waiting} (Shop): Change the colour. Status: proposed.`);
      expect(text).toContain(`${decided} (Shop): Change the colour. Status: approved.`);
      expect(text.trim().split('\n')).toHaveLength(2);
    });

    it('TUC-4/S4 search can ask for one status', async () => {
      const word = `quagga${String(Date.now())}`;
      const gherkin = `Feature: Stripes\n\n  Scenario: Show the ${word}\n    When I look\n    Then I see it\n`;
      const waiting = await propose(gherkin);
      const decided = await propose(gherkin);
      await approve(decided);

      const { text } = await call(agentA.token, 'search_usecases', {
        query: word,
        status: 'approved',
      });
      expect(text).toContain(decided);
      expect(text).not.toContain(`${waiting} `);
    });

    it('TUC-4/S4 quotes and symbols in a search are only words, and no words is refused', async () => {
      const odd = await call(agentA.token, 'search_usecases', { query: `nothing' & !:* (here` });
      expect(odd).toMatchObject({ isError: false, text: 'No use cases match.' });
      expect(await call(agentA.token, 'search_usecases', { query: '!!!' })).toMatchObject({
        isError: true,
        text: 'Search for at least one word.',
      });
    });

    it('TUC-4/S4 an agent gets nothing from another team, by search or by ID', async () => {
      const word = `okapi${String(Date.now())}`;
      const gherkin = `Feature: Forest\n\n  Scenario: Show the ${word}\n    When I look\n    Then I see it\n`;
      const inBravo = await propose(gherkin, agentB.token, REMOTE_B);

      const search = await call(agentA.token, 'search_usecases', { query: word });
      expect(search.text).toBe('No use cases match.');
      expect(await get(inBravo, agentA.token, REMOTE_B)).toMatchObject({
        isError: true,
        text: `${inBravo} wasn't found.`,
      });
      expect((await call(agentB.token, 'search_usecases', { query: word })).text).toContain(inBravo);
    });
  });

  describe('TUC-5: what an agent is told (the behaviour itself is proven by a real agent)', () => {
    it('TUC-5/S1 the server tells a connecting agent to end its turn, and not to poll or build', async () => {
      const instructions = must((await agent(agentA.token)).getInstructions(), 'instructions');
      expect(instructions).toContain('end your turn and tell the user');
      expect(instructions).toContain("Don't keep checking its status");
      expect(instructions).toContain("don't start building");
    });

    it('TUC-5/S2 the server tells it to fetch the status on return, and to revise before building', async () => {
      const instructions = must((await agent(agentA.token)).getInstructions(), 'instructions');
      expect(instructions).toContain('Call get_usecase once. Build only if the status is approved.');
      expect(instructions).toContain('If changes were requested');
    });
  });

  describe('the lifecycle', () => {
    const post = (path: string, payload?: object, cookie = memberA) =>
      http({ cookie }, 'POST', `/api/t/acme/usecases/${path}`, payload);
    const get = (ref: string) => call(agentA.token, 'get_usecase', { remote: REMOTE_A, id: ref });
    /** Stands in for going live, until reports do it. */
    const goLive = (id: string) =>
      withScope(pool, { bypass: true }, (db) =>
        db.query(`UPDATE revisions SET state = 'live' WHERE use_case_id = $1 AND state = 'approved'`, [id]),
      );
    async function done() {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await post(`${id}/approve`);
      await goLive(id);
      return { ref, id };
    }

    it('TUC-10/S1 a person rejects with a reason: it leaves the inbox and stays searchable', async () => {
      const word = `tapir${String(Date.now())}`;
      const ref = await propose(`Feature: F\n\n  Scenario: ${word}\n    When I look\n    Then I see\n`);
      const { id } = await inboxItem(ref);
      const response = await post(`${id}/reject`, { reason: 'We decided against this.' });
      expect(response.json()).toEqual({ status: 'rejected' });
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
      const found = await call(agentA.token, 'search_usecases', { query: word, status: 'rejected' });
      expect(found.text).toContain(`${ref} (Shop)`);
      const read = await get(ref);
      expect(read.text).toContain('Status: rejected.');
      expect(read.text).toContain('Do not build it.');
      expect(read.text).toContain('We decided against this.');
    });

    it('TUC-10/S2 rejecting without a reason is refused', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      expect((await post(`${id}/reject`, {})).statusCode).toBe(400);
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(true);
    });

    it('TUC-10/S3 a rejected use case cannot be revised', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await post(`${id}/reject`, { reason: 'No.' });
      const revised = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Trying again',
        gherkin: GHERKIN,
      });
      expect(revised).toMatchObject({ isError: true });
      expect(revised.text).toContain('was rejected');
    });

    it('TUC-10/S4 an agent cannot reject or retire: no tool, and a token is refused', async () => {
      const { id } = await inboxItem(await propose());
      const { tools } = await (await agent(agentA.token)).listTools();
      expect(tools.map((t) => t.name)).not.toContain('reject_usecase');
      expect(tools.map((t) => t.name)).not.toContain('retire_usecase');
      for (const action of ['reject', 'retire']) {
        const response = await http(
          { token: agentA.token },
          'POST',
          `/api/t/acme/usecases/${id}/${action}`,
          { reason: 'Because I can.' },
        );
        expect(response.statusCode).toBe(403);
      }
    });

    it('TUC-11/S1 changing a done use case makes a new revision, and the live one stays in force', async () => {
      const { ref, id } = await done();
      expect((await get(ref)).text).toContain('Status: done.');
      const revised = await call(agentA2.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Colours can have names now.',
        gherkin: 'Feature: Change the colour\n\n  @S1\n  Scenario: Change it\n    When I name a colour\n    Then the app uses it\n',
      });
      expect(revised.isError, revised.text).toBe(false);
      expect((await inboxItem(ref)).revision).toBe(2);

      const read = (await get(ref)).text;
      expect(read).toContain('Status: done.');
      expect(read).toContain('Revision 1 is live and stays in force.');
      expect(read).toContain('Revision 2 is proposed.');
      expect(read).toContain('When I name a colour');
      expect(read).toContain('When I change the primary colour');
      await post(`${id}/approve`);
      expect((await get(ref)).text).toContain('Status: done.');
      expect((await get(ref)).text).toContain('Revision 2 is approved.');
    });

    it('TUC-12/S1 an agent files a retirement: still done, and in the inbox with the reason', async () => {
      const { ref } = await done();
      const filed = await call(agentA.token, 'request_retirement', {
        remote: REMOTE_A,
        id: ref,
        reason: 'The page was removed.',
      });
      expect(filed.isError, filed.text).toBe(false);
      expect((await get(ref)).text).toContain('Status: done.');
      expect(await inboxItem(ref)).toMatchObject({
        needsReview: false,
        retirement: { requestedBy: 'Agent A', reason: 'The page was removed.' },
      });
    });

    it('TUC-12/S1 only a done use case can have a retirement filed', async () => {
      const filed = await call(agentA.token, 'request_retirement', {
        remote: REMOTE_A,
        id: await propose(),
        reason: 'Why not.',
      });
      expect(filed).toMatchObject({ isError: true });
      expect(filed.text).toContain("isn't done");
    });

    it('TUC-12/S2 a person retires it: it stays readable, and agents are told not to build it', async () => {
      const { ref, id } = await done();
      const response = await post(`${id}/retire`, { reason: 'Removed in 2.0.' });
      expect(response.json()).toEqual({ status: 'retired' });
      const read = (await get(ref)).text;
      expect(read).toContain('Status: retired.');
      expect(read).toContain('Why it was retired: Removed in 2.0.');
      const revised = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Back again',
        gherkin: GHERKIN,
      });
      expect(revised.text).toContain('is retired');
    });

    it('TUC-12/S3 a person keeps it: the request goes, and it stays done', async () => {
      const { ref, id } = await done();
      await call(agentA.token, 'request_retirement', { remote: REMOTE_A, id: ref, reason: 'Unused.' });
      expect((await post(`${id}/keep`)).json()).toEqual({ status: 'done' });
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
      expect((await post(`${id}/keep`)).statusCode).toBe(409);
    });

    it('TUC-12/S4 a number is never used again, after rejection or retirement', async () => {
      const first = await propose();
      await post(`${(await inboxItem(first)).id}/reject`, { reason: 'No.' });
      const { ref: second, id } = await done();
      await post(`${id}/retire`, { reason: 'Gone.' });
      const third = await propose();
      const number = (ref: string) => Number(ref.slice(3));
      expect(number(second)).toBeGreaterThan(number(first));
      expect(number(third)).toBeGreaterThan(number(second));
    });

    it('TUC-13/S1 comments left when approving reach the agent, with a prompt to raise them', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await post(`${id}/comments`, { scenario: 2, body: 'Hmm.. well.. Alright?' });
      await post(`${id}/approve`);
      const read = (await get(ref)).text;
      expect(read).toContain('A person left comments on this revision when approving.');
      expect(read).toContain('Hmm.. well.. Alright?');
    });

    it('TUC-13/S2 approving without comments adds no such prompt', async () => {
      const ref = await propose();
      await post(`${(await inboxItem(ref)).id}/approve`);
      expect((await get(ref)).text).not.toContain('left comments');
    });
  });

  describe('TUC-14: agent review modes', () => {
    const setMode = (actorId: string, body: object) =>
      http({ cookie: adminA }, 'PATCH', `/api/t/acme/actors/${actorId}`, body);
    const review = (token: string, ref: string, decision: string, comment?: string) =>
      call(token, 'review_usecase', { remote: REMOTE_A, id: ref, decision, ...(comment ? { comment } : {}) });
    const method = (ref: string) =>
      withScope(pool, { bypass: true }, async (db) => {
        const { rows } = await db.query<{ approval_method: string | null; state: string }>(
          `SELECT r.approval_method, r.state FROM revisions r JOIN use_cases u ON u.id = r.use_case_id
            WHERE u.number = $1 AND u.team_id = (SELECT id FROM teams WHERE slug = 'acme')
            ORDER BY r.number DESC LIMIT 1`,
          [Number(ref.slice(3))],
        );
        return must(rows[0]);
      });
    const fresh = async (name: string) => {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`);
      return createAgent(pool, must(rows[0]).id, name);
    };

    it('TUC-14/S1 with human_approval, a person approves, and a reviewer agent can not', async () => {
      const reviewer = await fresh('Reviewer one');
      await setMode(reviewer.actorId, { canReview: true });
      const ref = await propose();
      expect((await inboxItem(ref)).needsReview).toBe(true);
      const answer = await review(reviewer.token, ref, 'approve');
      expect(answer.text).toContain('waits for a person');
      expect(await method(ref)).toMatchObject({ state: 'proposed', approval_method: null });
    });

    it('TUC-14/S2 with agent_review, a different reviewer approves, and the record says so', async () => {
      const proposer = await fresh('Proposer two');
      const reviewer = await fresh('Reviewer two');
      await setMode(proposer.actorId, { review: 'agent_review' });
      await setMode(reviewer.actorId, { canReview: true });
      const ref = await propose(GHERKIN, proposer.token);
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
      const answer = await review(reviewer.token, ref, 'approve');
      expect(answer.text).toBe(`${ref} is now approved.`);
      expect(await method(ref)).toEqual({ state: 'approved', approval_method: 'agent_review' });
    });

    it('TUC-14/S3 agent_review refuses a proposal without the user request', async () => {
      const proposer = await fresh('Proposer three');
      await setMode(proposer.actorId, { review: 'agent_review' });
      const before = await useCaseCount();
      const answer = await call(proposer.token, 'propose_usecase', {
        remote: REMOTE_A,
        title: 'No request',
        gherkin: GHERKIN,
      });
      expect(answer).toMatchObject({ isError: true });
      expect(answer.text).toContain('original_request');
      expect(await useCaseCount()).toBe(before);
    });

    it('TUC-14/S4 an agent can not approve its own proposal, also through a reworded revision', async () => {
      const proposer = await fresh('Proposer four');
      const other = await fresh('Reviewer four');
      await setMode(proposer.actorId, { review: 'agent_review', canReview: true });
      await setMode(other.actorId, { canReview: true });

      const ref = await propose(GHERKIN, proposer.token);
      expect((await review(proposer.token, ref, 'approve')).text).toContain("can't review it");

      await review(other.token, ref, 'request_changes', 'Say more.');
      await call(proposer.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Said more.',
        gherkin: GHERKIN.replace('Change it', 'Change it now'),
      });
      expect((await review(proposer.token, ref, 'approve')).text).toContain("can't review it");
      expect(await method(ref)).toMatchObject({ state: 'proposed' });
    });

    it('TUC-14/S5 reviewing needs reviewer rights, and asking for changes needs a comment', async () => {
      const proposer = await fresh('Proposer five');
      const other = await fresh('Reviewer five');
      await setMode(proposer.actorId, { review: 'agent_review' });
      const ref = await propose(GHERKIN, proposer.token);
      const offered = async () =>
        (await (await agent(other.token)).listTools()).tools.map((t) => t.name);
      expect(await offered()).not.toContain('review_usecase');
      expect(await review(other.token, ref, 'approve')).toMatchObject({ isError: true });
      expect(await method(ref)).toMatchObject({ state: 'proposed' });
      await setMode(other.actorId, { canReview: true });
      expect(await offered()).toContain('review_usecase');
      expect((await review(other.token, ref, 'request_changes')).text).toContain('what should change');
    });

    it('TUC-14/S6 auto_approve approves on arrival, and the record says nobody checked', async () => {
      const proposer = await fresh('Proposer six');
      await setMode(proposer.actorId, { review: 'auto_approve' });
      const { text } = await call(proposer.token, 'propose_usecase', {
        remote: REMOTE_A,
        title: 'Auto',
        gherkin: GHERKIN,
      });
      expect(text).toContain('Status: approved.');
      expect(text).toContain('does not widen your task');
      const ref = must(/UC-\d+/.exec(text)?.[0]);
      expect(await method(ref)).toEqual({ state: 'approved', approval_method: 'auto_approve' });
      expect((await inbox(memberA)).some((i) => i.ref === ref)).toBe(false);
    });

    it('TUC-14/S7 auto_approve still can not retire: the request waits for a person', async () => {
      const proposer = await fresh('Proposer seven');
      await setMode(proposer.actorId, { review: 'auto_approve' });
      const { text } = await call(proposer.token, 'propose_usecase', {
        remote: REMOTE_A,
        title: 'Auto',
        gherkin: GHERKIN,
      });
      const ref = must(/UC-\d+/.exec(text)?.[0]);
      await withScope(pool, { bypass: true }, (db) =>
        db.query(
          `UPDATE revisions SET state = 'live' WHERE state = 'approved' AND use_case_id =
            (SELECT id FROM use_cases WHERE number = $1 AND team_id = (SELECT id FROM teams WHERE slug = 'acme'))`,
          [Number(ref.slice(3))],
        ),
      );
      await call(proposer.token, 'request_retirement', { remote: REMOTE_A, id: ref, reason: 'Gone.' });
      const read = await call(proposer.token, 'get_usecase', { remote: REMOTE_A, id: ref });
      expect(read.text).toContain('Status: done.');
      expect((await inboxItem(ref)).retirement).toMatchObject({ reason: 'Gone.' });
    });

    it('TUC-14/S8 an agent gets a 403 when it tries to change its own mode', async () => {
      const proposer = await fresh('Proposer eight');
      const response = await http(
        { token: proposer.token },
        'PATCH',
        `/api/t/acme/actors/${proposer.actorId}`,
        { review: 'auto_approve' },
      );
      expect(response.statusCode).toBe(403);
    });
  });

  describe('TUC-6: a person sets up a team', () => {
    const admin = (method: string, path: string, payload?: object) =>
      http({ cookie: adminA }, method, `/api/t/acme${path}`, payload);

    it('TUC-6/S1 an admin adds a project and a repository, and agents propose into it', async () => {
      const remote = 'https://github.com/acme/settings-site.git';
      const response = await admin('POST', '/projects', { name: 'Settings site', remote });
      expect(response.statusCode).toBe(201);
      const { text, isError } = await call(agentA.token, 'propose_usecase', {
        remote,
        title: 'Works',
        gherkin: GHERKIN,
      });
      expect(isError, text).toBe(false);
      expect(text).toContain('UC-1 ');

      const projectId = response.json<{ id: string }>().id;
      const second = await admin('POST', `/projects/${projectId}/repositories`, {
        remote: 'git@github.com:acme/settings-api.git',
        defaultBranch: 'trunk',
      });
      expect(second.statusCode).toBe(201);
      const settings = (await admin('GET', '/settings')).json<TeamSettings>();
      expect(settings.projects.find((p) => p.id === projectId)?.repositories).toMatchObject([
        { remote: 'github.com/acme/settings-api', defaultBranch: 'trunk' },
        { remote: 'github.com/acme/settings-site', defaultBranch: 'main' },
      ]);
    });

    it('TUC-6/S1 a bad remote or an unknown Gherkin language is refused', async () => {
      expect((await admin('POST', '/projects', { name: 'X', remote: 'nonsense' })).statusCode).toBe(400);
      expect(
        (await admin('POST', '/projects', { name: 'Y', remote: 'https://github.com/a/y.git', language: 'xx' }))
          .statusCode,
      ).toBe(400);
    });

    it('TUC-6/S2 an admin adds an agent, and sees its token once', async () => {
      const response = await admin('POST', '/actors', { name: 'New agent', kind: 'agent' });
      expect(response.statusCode).toBe(201);
      const { token, actorId } = response.json<{ token: string; actorId: string }>();
      expect((await call(token, 'search_usecases', { query: 'colour' })).isError).toBe(false);
      const settings = (await admin('GET', '/settings')).body;
      expect(settings).toContain(actorId);
      expect(settings).not.toContain(token);
    });

    it('TUC-6/S3 revoking a token stops it working', async () => {
      const { token, actorId } = (await admin('POST', '/actors', { name: 'Short lived', kind: 'agent' }))
        .json<{ token: string; actorId: string }>();
      const settings = (await admin('GET', '/settings')).json<TeamSettings>();
      const tokenId = must(settings.actors.find((a) => a.id === actorId)?.tokens[0]).id;
      expect((await admin('DELETE', `/tokens/${tokenId}`)).statusCode).toBe(200);
      const refused = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(401);
    });

    it('TUC-6/S4 a server admin adds a team and a member, who can sign in and see the inbox', async () => {
      const serverAdmin = await signIn('root@server.test', 'root-password');
      const created = await http({ cookie: serverAdmin }, 'POST', '/api/admin/teams', { name: 'New Co' });
      expect(created.statusCode).toBe(201);
      const { slug } = created.json<{ slug: string }>();
      expect(slug).toBe('new-co');
      const added = await http({ cookie: serverAdmin }, 'POST', `/api/t/${slug}/members`, {
        email: 'nora@newco.test',
        name: 'Nora',
        role: 'member',
      });
      expect(added.statusCode).toBe(201);
      const { password } = added.json<{ password: string }>();
      const nora = await signIn('nora@newco.test', password);
      expect((await inbox(nora, slug))).toEqual([]);
    });

    it('TUC-6/S4 only a server admin adds teams, and only a team admin reaches settings', async () => {
      expect((await http({ cookie: adminA }, 'POST', '/api/admin/teams', { name: 'Nope' })).statusCode).toBe(403);
      expect((await http({ cookie: memberA }, 'GET', '/api/t/acme/settings')).statusCode).toBe(403);
      expect((await http({ token: agentA.token }, 'GET', '/api/t/acme/settings')).statusCode).toBe(403);
    });

    it('TUC-6/S4 an admin changes a role and removes a member, but not themselves', async () => {
      const { accountId } = (await admin('POST', '/members', {
        email: 'temp@acme.test',
        name: 'Temp',
        role: 'member',
      })).json<{ accountId: string }>();
      expect((await admin('PATCH', `/members/${accountId}`, { role: 'admin' })).statusCode).toBe(200);
      const settings = (await admin('GET', '/settings')).json<TeamSettings>();
      expect(settings.members.find((m) => m.accountId === accountId)?.role).toBe('admin');
      expect((await admin('DELETE', `/members/${accountId}`)).statusCode).toBe(200);
      const self = settings.members.find((m) => m.email === 'ada@acme.test');
      expect((await admin('DELETE', `/members/${must(self).accountId}`)).statusCode).toBe(409);
    });
  });

  describe('reports, health and going live', () => {
    const REMOTE_C = 'https://github.com/acme/api-server.git';
    let ci: { token: string };
    const junit = (tests: Record<string, 'pass' | 'fail' | 'skip'>) =>
      `<?xml version="1.0"?><testsuites><testsuite name="s">${Object.entries(tests)
        .map(([name, r]) =>
          r === 'pass'
            ? `<testcase classname="c" name="${name}"/>`
            : r === 'fail'
              ? `<testcase classname="c" name="${name}"><failure>no</failure></testcase>`
              : `<testcase classname="c" name="${name}"><skipped/></testcase>`,
        )
        .join('')}</testsuite></testsuites>`;
    const report = (xml: string, over: object = {}, token = ci.token) =>
      http({ token }, 'POST', '/api/v1/reports', {
        remote: REMOTE_A,
        branch: 'main',
        suite: 'unit',
        commit: 'abc1234def',
        junit: xml,
        ...over,
      });
    const get = async (ref: string) =>
      (await call(agentA.token, 'get_usecase', { remote: REMOTE_A, id: ref })).text;
    const eventsOf = (ref: string) =>
      withScope(pool, { bypass: true }, async (db) => {
        const { rows } = await db.query<{ scenario_number: number; health: string }>(
          `SELECT e.scenario_number, e.health FROM scenario_events e
             JOIN use_cases u ON u.id = e.use_case_id
            WHERE u.number = $1 AND u.team_id = (SELECT id FROM teams WHERE slug = 'acme')
            ORDER BY e.created_at`,
          [Number(ref.slice(3))],
        );
        return rows;
      });
    async function approved() {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      return { ref, id };
    }
    const claim = (ref: string) =>
      call(agentA.token, 'claim_done', {
        remote: REMOTE_A,
        id: ref,
        pr_url: 'https://github.com/acme/shop/pull/7',
        merge_sha: 'abc1234def',
      });

    beforeAll(async () => {
      const created = await http({ cookie: adminA }, 'POST', '/api/t/acme/actors', {
        name: 'CI',
        kind: 'ci',
      });
      ci = created.json<{ token: string }>();
      const shop = (await http({ cookie: adminA }, 'GET', '/api/t/acme/settings')).json<TeamSettings>();
      const project = must(shop.projects.find((p) => p.slug === 'shop'));
      await http({ cookie: adminA }, 'POST', `/api/t/acme/projects/${project.id}/repositories`, {
        remote: REMOTE_C,
      });
    });

    it('TUC-15/S1 a report with tagged tests makes scenarios pass, and the file is not stored', async () => {
      const { ref } = await approved();
      const response = await report(junit({ [`${ref}/S1 changes it`]: 'pass', [`${ref}/S2 refuses`]: 'pass' }));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ scenarios: 2, unknownTags: [], wentLive: [] });
      const text = await get(ref);
      expect(text).toContain('Health: passing.');
      expect(text).toContain(`${ref}/S1: passing`);
      const columns = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ table_name: string; column_name: string }>(
          `SELECT table_name, column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name ~* 'junit|xml|report_file|raw'`,
        ),
      );
      expect(columns.rows).toEqual([]);
    });

    it('TUC-15/S2 a repeat report adds no history', async () => {
      const { ref } = await approved();
      const xml = junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' });
      await report(xml);
      const first = await eventsOf(ref);
      expect(first).toHaveLength(2);
      await report(xml);
      expect(await eventsOf(ref)).toEqual(first);
    });

    it('TUC-15/S3 a deleted or skipped test becomes no evidence', async () => {
      const { ref } = await approved();
      await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }));
      await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'skip' }));
      expect(await get(ref)).toContain(`${ref}/S2: no evidence`);
      await report(junit({ [`${ref}/S2 b`]: 'pass' }));
      const text = await get(ref);
      expect(text).toContain(`${ref}/S1: no evidence`);
      expect(text).toContain('Health: no evidence.');
    });

    it('TUC-15/S4 one failing repository makes the scenario fail', async () => {
      const { ref } = await approved();
      await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }));
      await report(junit({ [`${ref}/S1 a`]: 'fail' }), { remote: REMOTE_C });
      const text = await get(ref);
      expect(text).toContain(`${ref}/S1: failing`);
      expect(text).toContain('Health: failing.');
      expect(await eventsOf(ref)).toContainEqual({ scenario_number: 1, health: 'failing' });
    });

    it('TUC-15/S5 suites do not overwrite each other', async () => {
      const { ref } = await approved();
      await report(junit({ [`${ref}/S1 a`]: 'pass' }), { suite: 'unit' });
      await report(junit({ [`${ref}/S2 b`]: 'pass' }), { suite: 'e2e' });
      expect(await get(ref)).toContain('Health: passing.');
    });

    it('TUC-15/S6 a report from another branch is refused, and changes nothing', async () => {
      const { ref } = await approved();
      const response = await report(junit({ [`${ref}/S1 a`]: 'pass' }), { branch: 'feature/x' });
      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toContain('default branch, main');
      expect(await get(ref)).toContain(`${ref}/S1: no evidence`);
    });

    it('TUC-15/S7 an unknown or retired ID does not fail, and the answer lists it', async () => {
      const { ref, id } = await approved();
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/retire`, { reason: 'Gone.' });
      const response = await report(junit({ 'UC-999999/S1 old': 'pass', [`${ref}/S1 a`]: 'pass' }));
      expect(response.statusCode).toBe(200);
      expect(response.json<{ unknownTags: string[] }>().unknownTags).toEqual(
        expect.arrayContaining(['UC-999999/S1', `${ref}/S1`]),
      );
    });

    it('TUC-15/S8 only a CI token can upload, and bad XML is refused', async () => {
      expect((await report('<testsuites/>', {}, agentA.token)).statusCode).toBe(403);
      expect((await http({ cookie: memberA }, 'POST', '/api/v1/reports', {})).statusCode).toBe(401);
      expect((await report('not xml')).statusCode).toBe(400);
      const refused = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ci.token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(403);
    });

    it('TUC-15/S9 a report takes a small, fixed number of database round trips', async () => {
      const { rows } = await pool.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`);
      const teamId = must(rows[0]).id;
      const { ref } = await approved();
      const many = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`${ref}/S1 test ${String(i)}`, 'pass' as const]),
      );
      await withScope(pool, { teamId }, async (db) => {
        const spy = vi.spyOn(db, 'query');
        await uploadReport(db, { teamId }, {
          remote: REMOTE_A,
          branch: 'main',
          suite: 'many',
          commit: 'abc1234def',
          junit: junit(many),
        });
        expect(spy.mock.calls.length).toBeLessThanOrEqual(8);
        spy.mockRestore();
      });
    });

    it('TUC-16/S1 a claimed use case goes live on the next good report: done, passing', async () => {
      const { ref } = await approved();
      const xml = junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' });
      expect((await claim(ref)).isError).toBe(false);
      expect(await get(ref)).toContain('Status: approved.');
      const response = await report(xml);
      expect(response.json<{ wentLive: string[] }>().wentLive).toContain(ref);
      const text = await get(ref);
      expect(text).toContain('Status: done. Health: passing.');
    });

    it('TUC-16/S2 breaking its test reads done, failing, and the status stays', async () => {
      const { ref } = await approved();
      await claim(ref);
      await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }));
      await report(junit({ [`${ref}/S1 a`]: 'fail', [`${ref}/S2 b`]: 'pass' }));
      expect(await get(ref)).toContain('Status: done. Health: failing.');
    });

    it('TUC-16/S3 passing tests alone do not make an approved use case go live', async () => {
      const { ref } = await approved();
      const response = await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }));
      expect(response.json<{ wentLive: string[] }>().wentLive).toEqual([]);
      expect(await get(ref)).toContain('Status: approved.');
    });

    it('TUC-16/S4 a new revision does not go live before its claim, and needs all its scenarios', async () => {
      const { ref, id } = await approved();
      await claim(ref);
      await report(junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }));
      const revised = await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'A new scenario',
        gherkin: `Feature: Change the colour

  @S1
  Scenario: Change it
    When I change the primary colour
    Then the app uses the new colour

  @S2
  Scenario: Refuse a bad colour
    When I enter a value that isn't a colour
    Then I see an error

  Scenario: Reset it
    When I reset the colour
    Then the app uses the default
`,
      });
      expect(revised.isError, revised.text).toBe(false);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);

      const old = junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' });
      expect((await report(old)).json<{ wentLive: string[] }>().wentLive).toEqual([]);
      expect(await get(ref)).toContain('Revision 1 is live');

      await claim(ref);
      expect((await report(old)).json<{ wentLive: string[] }>().wentLive).toEqual([]);

      const all = junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass', [`${ref}/S3 c`]: 'pass' });
      expect((await report(all)).json<{ wentLive: string[] }>().wentLive).toContain(ref);
      const text = await get(ref);
      expect(text).toContain('Status: done. Health: passing. Revision 2.');
      expect(text).not.toContain('The live text');
    });

    it('TUC-16/S5 only the latest approved revision can be claimed', async () => {
      const claimed = await claim(await propose());
      expect(claimed).toMatchObject({ isError: true });
      expect(claimed.text).toContain("can't be claimed");
    });

    it('TUC-16/S6 search filters by health and by how it was approved', async () => {
      const word = `saola${String(Date.now())}`;
      const gherkin = `Feature: F\n\n  Scenario: ${word}\n    When I look\n    Then I see\n`;
      const ref = await propose(gherkin);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${(await inboxItem(ref)).id}/approve`);
      const find = async (args: object) =>
        (await call(agentA.token, 'search_usecases', { query: word, ...args })).text;
      expect(await find({ health: 'no_evidence' })).toContain(ref);
      expect(await find({ health: 'passing' })).toBe('No use cases match.');
      expect(await find({ approval: 'human' })).toContain(ref);
      expect(await find({ approval: 'auto_approve' })).toBe('No use cases match.');
    });

    describe('the PR check', () => {
      const check = (body: object, token = ci.token) =>
        http({ token }, 'POST', '/api/v1/check', { remote: REMOTE_A, ...body });

      it('TUC-17/S1 no IDs and no exemption fails', async () => {
        const { ok, problems } = (await check({})).json<CheckAnswer>();
        expect(ok).toBe(false);
        expect(problems[0]).toContain('Use cases: UC-142');
      });

      it('TUC-17/S2 an exemption passes, and the reason is visible', async () => {
        const answer = (await check({ exemption: 'Dependency bump.' })).json<CheckAnswer>();
        expect(answer).toEqual({ ok: true, problems: [], notes: ['Exempt: Dependency bump.'] });
      });

      it('TUC-17/S3 an unapproved use case fails', async () => {
        const ref = await propose();
        const { ok, problems } = (await check({
          useCases: [ref],
          junit: junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }),
        })).json<CheckAnswer>();
        expect(ok).toBe(false);
        expect(problems[0]).toContain(`${ref} isn't approved`);
      });

      it('TUC-17/S4 a scenario with no tagged test fails, and a skipped test does not count', async () => {
        const { ref } = await approved();
        const { ok, problems } = (await check({
          useCases: [ref],
          junit: junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'skip' }),
        })).json<CheckAnswer>();
        expect(ok).toBe(false);
        expect(problems).toEqual([`${ref}/S2 has no tagged test.`]);
      });

      it('TUC-17/S5 a test tagged only in another repository counts, and says so', async () => {
        const { ref } = await approved();
        await report(junit({ [`${ref}/S2 b`]: 'pass' }), { remote: REMOTE_C });
        const answer = (await check({
          useCases: [ref],
          junit: junit({ [`${ref}/S1 a`]: 'pass' }),
        })).json<CheckAnswer>();
        expect(answer.ok).toBe(true);
        expect(answer.notes).toEqual([`${ref}/S2 is proven in another repository.`]);
      });

      it('TUC-17/S6 all scenarios tested passes, and the check stores nothing', async () => {
        const { ref } = await approved();
        const answer = (await check({
          useCases: [ref],
          junit: junit({ [`${ref}/S1 a`]: 'pass', [`${ref}/S2 b`]: 'pass' }),
        })).json<CheckAnswer>();
        expect(answer).toEqual({ ok: true, problems: [], notes: [] });
        expect(await get(ref)).toContain(`${ref}/S1: no evidence`);
        expect(await eventsOf(ref)).toEqual([]);
      });

      it('TUC-17/S7 an unknown ID fails, and only a CI token can run it', async () => {
        const { problems } = (await check({ useCases: ['UC-999999'] })).json<CheckAnswer>();
        expect(problems).toEqual(["UC-999999 wasn't found in this project."]);
        expect((await check({}, agentA.token)).statusCode).toBe(403);
      });
    });
  });

  describe('the catalogue and a use case', () => {
    let ci: { token: string };
    const page = async (cookie = memberA) =>
      (await http({ cookie }, 'GET', '/api/t/acme/catalogue')).json<Catalogue>().items;
    const detail = async (id: string, cookie = memberA) =>
      (await http({ cookie }, 'GET', `/api/t/acme/usecases/${id}`)).json<UseCaseDetail>();
    const decide = (id: string, action: string, body?: object) =>
      http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/${action}`, body);
    const pass = (ref: string, names: string[]) =>
      http({ token: ci.token }, 'POST', '/api/v1/reports', {
        remote: REMOTE_A,
        branch: 'main',
        suite: 'catalogue',
        commit: 'cafe1234',
        junit: `<testsuite>${names.map((n) => `<testcase name="${ref}/${n} x"/>`).join('')}</testsuite>`,
      });

    beforeAll(async () => {
      ci = (await http({ cookie: adminA }, 'POST', '/api/t/acme/actors', { name: 'CI 2', kind: 'ci' }))
        .json<{ token: string }>();
    });

    it('TUC-18/S1 every use case shows with status, health and how it was approved', async () => {
      const waiting = await propose();
      const decided = await propose();
      const { id } = await inboxItem(decided);
      await decide(id, 'approve');
      const items = await page();
      expect(items.find((i) => i.ref === waiting)).toMatchObject({
        status: 'proposed',
        health: 'no_evidence',
        approval: null,
        pending: true,
      });
      expect(items.find((i) => i.ref === decided)).toMatchObject({
        status: 'approved',
        approval: 'human',
        pending: false,
      });
    });

    it('TUC-18/S2 another team reads as not found, in the list and by ID', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      const bravo = (await http({ cookie: memberB }, 'GET', '/api/t/bravo/catalogue')).json<Catalogue>();
      expect(bravo.items.some((i) => i.id === id)).toBe(false);
      expect((await http({ cookie: memberB }, 'GET', '/api/t/acme/catalogue')).statusCode).toBe(404);
      const response = await http({ cookie: memberB }, 'GET', `/api/t/bravo/usecases/${id}`);
      expect(response.statusCode).toBe(404);
    });

    it('TUC-18/S3 a use case shows scenarios with evidence, revisions and history', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      await pass(ref, ['S1']);
      const useCase = await detail(id);
      expect(useCase).toMatchObject({ ref, status: 'approved', health: 'no_evidence', revision: 1 });
      expect(useCase.scenarios[0]).toMatchObject({
        number: 1,
        name: 'Change it',
        health: 'passing',
        tests: [{ suite: 'catalogue', repository: 'github.com/acme/shop', commit: 'cafe1234' }],
      });
      expect(useCase.scenarios[1]).toMatchObject({ number: 2, health: 'no_evidence', tests: [] });
      expect(useCase.revisions[0]).toMatchObject({
        number: 1,
        state: 'approved',
        proposedBy: 'Agent A',
        approval: 'human',
        decidedBy: 'Mia',
      });
      expect(useCase.history).toMatchObject([{ scenario: 1, health: 'passing', commit: 'cafe1234' }]);
    });

    it('TUC-18/S4 a done use case with a newer revision shows both', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      await call(agentA.token, 'claim_done', {
        remote: REMOTE_A,
        id: ref,
        pr_url: 'https://github.com/acme/shop/pull/8',
        merge_sha: 'cafe1234',
      });
      await pass(ref, ['S1', 'S2']);
      await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'Reworded.',
        gherkin: GHERKIN.replace('Change it', 'Change the colour now'),
      });
      const useCase = await detail(id);
      expect(useCase).toMatchObject({ status: 'done', health: 'passing', revision: 1 });
      expect(useCase.newer).toMatchObject({ revision: 2, state: 'proposed' });
      expect(useCase.revisions.map((r) => r.state)).toEqual(['proposed', 'live']);
      expect(useCase.revisions[1]?.prUrl).toBe('https://github.com/acme/shop/pull/8');
      expect((await page()).find((i) => i.id === id)).toMatchObject({ pending: true, status: 'done' });
    });

    it('TUC-19/S1 a person checks a scenario by hand: it counts, and it is labelled', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      const verified = await decide(`${id}/scenarios/1`, 'verify', { note: 'Looked at it in the browser.' });
      expect(verified.statusCode).toBe(201);
      const useCase = await detail(id);
      expect(useCase.scenarios[0]).toMatchObject({
        health: 'passing',
        tests: [],
        manual: [{ by: 'Mia', note: 'Looked at it in the browser.' }],
      });
      const read = await call(agentA.token, 'get_usecase', { remote: REMOTE_A, id: ref });
      expect(read.text).toContain('verified by hand by Mia');
    });

    it('TUC-19/S2 a check needs a note, and a token can not make one', async () => {
      const { id } = await inboxItem(await propose());
      expect((await decide(`${id}/scenarios/1`, 'verify', {})).statusCode).toBe(400);
      const asAgent = await http(
        { token: agentA.token },
        'POST',
        `/api/t/acme/usecases/${id}/scenarios/1/verify`,
        { note: 'Trust me.' },
      );
      expect(asAgent.statusCode).toBe(403);
      expect((await decide(`${id}/scenarios/99`, 'verify', { note: 'x' })).statusCode).toBe(404);
    });

    it('TUC-19/S3 a claimed use case can go live on hand checks', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      await call(agentA.token, 'claim_done', {
        remote: REMOTE_A,
        id: ref,
        pr_url: 'https://github.com/acme/shop/pull/9',
        merge_sha: 'cafe1234',
      });
      await decide(`${id}/scenarios/1`, 'verify', { note: 'One.' });
      expect((await detail(id)).status).toBe('approved');
      await decide(`${id}/scenarios/2`, 'verify', { note: 'Two.' });
      expect((await detail(id)).status).toBe('done');
    });

    it('TUC-19/S4 a changed meaning gets a new number, which has no hand check', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(`${id}/scenarios/1`, 'verify', { note: 'Checked S1.' });
      await decide(id, 'request-changes', { changes: 'Different meaning.' });
      await call(agentA.token, 'revise_usecase', {
        remote: REMOTE_A,
        id: ref,
        what_changed: 'S1 means something else now.',
        gherkin: 'Feature: F\n\n  Scenario: Something else\n    When a\n    Then b\n',
      });
      const useCase = await detail(id);
      expect(useCase.scenarios).toMatchObject([{ number: 3, health: 'no_evidence', manual: [] }]);
    });

    it('TUC-19/S5 list_without_evidence names what nothing proves', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      await pass(ref, ['S1']);
      const { text } = await call(agentA.token, 'list_without_evidence', { remote: REMOTE_A });
      expect(text).toContain(`${ref}/S2: Change the colour`);
      expect(text).not.toContain(`${ref}/S1:`);
    });

    it('TUC-20/S1 an export holds everything a team has, and never a token or password', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'comments', { scenario: 1, body: 'Fine.' });
      await decide(id, 'approve');
      const response = await http({ cookie: adminA }, 'GET', '/api/t/acme/export');
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toContain('openusecase-acme.json');
      const data = response.json<TeamExport>();
      const useCase = must(
        must(data.projects.find((p) => p.slug === 'shop')).useCases.find((u) => `UC-${String(u.number)}` === ref),
      );
      expect(useCase.revisions[0]).toMatchObject({ state: 'approved', approvalMethod: 'human' });
      expect(useCase.comments[0]).toMatchObject({ scenario: 1, body: 'Fine.' });
      expect(response.body).not.toContain(agentA.token);
      expect(response.body).not.toMatch(/token_hash|password|scrypt/);
      // A server connection, its public key and sealed token stay out of exports.
      await withScope(pool, { bypass: true }, (db) =>
        db.query(
          `INSERT INTO server_integrations (kind, url, public_key, deploy_token_encrypted)
           VALUES ('openversion', 'https://versions.example.com', 'pk_export_check_0123456789', 'sealed-export-check')
           ON CONFLICT (kind) DO UPDATE SET url = EXCLUDED.url, public_key = EXCLUDED.public_key,
             deploy_token_encrypted = EXCLUDED.deploy_token_encrypted`,
        ),
      );
      const withConnection = (await http({ cookie: adminA }, 'GET', '/api/t/acme/export')).body;
      expect(withConnection).not.toContain('pk_export_check_0123456789');
      expect(withConnection).not.toContain('sealed-export-check');
      expect(withConnection).not.toContain('versions.example.com');
      expect((await http({ cookie: memberA }, 'GET', '/api/t/acme/export')).statusCode).toBe(403);
    });

    it('TUC-20/S2 importing into an empty team brings it back, IDs and records intact', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      await decide(id, 'approve');
      const data = (await http({ cookie: adminA }, 'GET', '/api/t/acme/export')).json<TeamExport>();
      const before = must(data.projects.find((p) => p.slug === 'shop'));

      const root = await signIn('root@server.test', 'root-password');
      const { slug } = (await http({ cookie: root }, 'POST', '/api/admin/teams', { name: 'Restored' }))
        .json<{ slug: string }>();
      const imported = await http({ cookie: root }, 'POST', `/api/t/${slug}/import`, data);
      expect(imported.statusCode, imported.body).toBe(201);

      const again = (await http({ cookie: root }, 'GET', `/api/t/${slug}/catalogue`)).json<Catalogue>();
      const restored = must(again.items.find((i) => i.ref === ref && i.project.slug === 'shop'));
      expect(restored).toMatchObject({ status: 'approved', approval: 'human' });
      const after = (await http({ cookie: root }, 'GET', `/api/t/${slug}/export`)).json<TeamExport>();
      expect(must(after.projects.find((p) => p.slug === 'shop')).nextUseCaseNumber).toBe(before.nextUseCaseNumber);

      const twice = await http({ cookie: root }, 'POST', `/api/t/${slug}/import`, data);
      expect(twice.statusCode).toBe(409);
      expect((await http({ cookie: root }, 'POST', `/api/t/${slug}/import`, { nope: 1 })).statusCode).toBe(400);
    });
  });

  describe('TUC-8: use cases are grouped by area', () => {
    const REMOTE_D = 'https://github.com/acme/billing.git';
    const GH = 'Feature: F\n\n  Scenario: A\n    When I look\n    Then I see\n';
    const projectSlug = 'billing-app';
    const proposeIn = (args: object) =>
      call(agentA.token, 'propose_usecase', { remote: REMOTE_D, title: 'T', gherkin: GH, ...args });
    const refOf = (text: string) => must(/UC-\d+/.exec(text)?.[0]);
    const inProject = async (ref: string) =>
      must((await inbox(memberA)).find((i) => i.ref === ref && i.project.slug === projectSlug));
    const approve = async (ref: string) => {
      const { id } = await inProject(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      return id;
    };

    beforeAll(async () => {
      await http({ cookie: adminA }, 'POST', '/api/t/acme/projects', { name: 'Billing app', remote: REMOTE_D });
    });

    it('TUC-8/S3 a new area is proposed with a use case, seen as new, and added on approval', async () => {
      const first = refOf((await proposeIn({ new_area: 'Billing' })).text);
      expect(await inProject(first)).toMatchObject({ area: 'Billing', newArea: true });
      expect((await call(agentA.token, 'list_areas', { remote: REMOTE_D })).text).toBe(
        'This project has no areas yet.',
      );
      await approve(first);
      expect((await call(agentA.token, 'list_areas', { remote: REMOTE_D })).text).toBe('Billing');
    });

    it('TUC-8/S1 an agent files a use case under an area, and the inbox shows it', async () => {
      const ref = refOf((await proposeIn({ area: 'billing' })).text);
      expect(await inProject(ref)).toMatchObject({ area: 'Billing', newArea: false });
    });

    it('TUC-8/S2 without an area, or with one that does not exist, it is refused and told which exist', async () => {
      const before = await useCaseCount();
      const missing = await proposeIn({});
      expect(missing).toMatchObject({ isError: true });
      expect(missing.text).toContain('Billing');
      const wrong = await proposeIn({ area: 'Settings' });
      expect(wrong.text).toContain('The areas are: Billing');
      expect(await useCaseCount()).toBe(before);
    });

    it('TUC-8/S4 a person moves it: the ID and approval stay, and agents are refused', async () => {
      const ref = refOf((await proposeIn({ area: 'Billing' })).text);
      const id = await approve(ref);
      const moved = await http({ cookie: memberA }, 'PATCH', `/api/t/acme/usecases/${id}/area`, { area: 'Invoices' });
      expect(moved.statusCode).toBe(200);
      const useCase = (await http({ cookie: memberA }, 'GET', `/api/t/acme/usecases/${id}`)).json<UseCaseDetail>();
      expect(useCase).toMatchObject({ ref, area: 'Invoices', status: 'approved' });
      expect(useCase.areas).toEqual(['Billing', 'Invoices']);
      const asAgent = await http({ token: agentA.token }, 'PATCH', `/api/t/acme/usecases/${id}/area`, { area: 'X' });
      expect(asAgent.statusCode).toBe(403);
    });

    it('TUC-8/S3 a rejected use case does not add its new area', async () => {
      const ref = refOf((await proposeIn({ new_area: 'Nope' })).text);
      const { id } = await inProject(ref);
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/reject`, { reason: 'No.' });
      expect((await call(agentA.token, 'list_areas', { remote: REMOTE_D })).text).not.toContain('Nope');
    });
  });

  describe('the glossary in OpenPurpose (no approved use case yet)', () => {
    let stub: Server;
    let stubUrl: string;
    let answer: { status: number; body: unknown };
    let calls: { path: string; auth: string | undefined; body: string }[];
    const admin = (method: string, path: string, payload?: object) =>
      http({ cookie: adminA }, method, `/api/t/acme/openpurpose${path}`, payload);
    const terms = async () =>
      (await http({ cookie: memberA }, 'GET', '/api/t/acme/projects/shop/terms')).json<Glossary>();
    // The shape of OpenPurpose's POST /api/context: its `blocks`, general first.
    const CONTEXT = {
      blocks: [
        {
          documents: [
            { kind: 'glossary', sections: [{ heading: 'Member', body: 'Org: someone in a [[Team]].' }] },
            { kind: 'guidelines', sections: [{ heading: 'Not a term', body: 'x' }] },
          ],
        },
        {
          documents: [
            {
              kind: 'glossary',
              sections: [
                { heading: 'Member', body: 'Someone who signs in to a [[Team]].' },
                { heading: 'Team', body: 'The tenant.' },
              ],
            },
          ],
        },
      ],
    };

    beforeAll(async () => {
      answer = { status: 200, body: CONTEXT };
      calls = [];
      stub = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          calls.push({ path: request.url ?? '', auth: request.headers.authorization, body });
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(answer.body));
        });
      });
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
      stubUrl = `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}`;
    });

    afterAll(async () => {
      await new Promise((resolve) => stub.close(resolve));
    });

    it('without the integration, no terms and everything else works', async () => {
      expect(await terms()).toEqual({ state: 'off', terms: [] });
      const instructions = must((await agent(agentA.token)).getInstructions());
      expect(instructions).not.toContain('list_terms');
      const { tools } = await (await agent(agentA.token)).listTools();
      expect(tools.map((t) => t.name)).not.toContain('list_terms');
    });

    it('an admin adds the link, and a wrong token is refused before it is saved', async () => {
      answer = { status: 401, body: {} };
      const wrong = await admin('PUT', '', { url: stubUrl, token: 'bad' });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json<{ error: string }>().error).toContain('refused that token');
      expect((await admin('GET', '')).json()).toEqual({ url: null });

      answer = { status: 200, body: {} };
      expect((await admin('PUT', '', { url: `${stubUrl}/`, token: 'op-secret' })).statusCode).toBe(200);
      expect((await admin('GET', '')).json()).toEqual({ url: stubUrl });
      const stored = await withScope(pool, { bypass: true }, (db) =>
        db.query<{ token_sealed: string }>('SELECT token_sealed FROM openpurpose_links'),
      );
      expect(must(stored.rows[0]).token_sealed).not.toContain('op-secret');
      expect((await http({ cookie: memberA }, 'GET', '/api/t/acme/openpurpose')).statusCode).toBe(403);
      expect((await http({ token: agentA.token }, 'GET', '/api/t/acme/openpurpose')).statusCode).toBe(403);
      expect((await http({ cookie: adminA }, 'GET', '/api/t/acme/export')).body).not.toContain('op-secret');
    });

    it('the terms come from OpenPurpose, with the most specific definition, and are kept a while', async () => {
      answer = { status: 200, body: CONTEXT };
      calls.length = 0;
      expect(await terms()).toEqual({
        state: 'ok',
        terms: [
          { term: 'Member', definition: 'Someone who signs in to a Team.' },
          { term: 'Team', definition: 'The tenant.' },
        ],
      });
      await terms();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ path: '/api/context', auth: 'Bearer op-secret' });
      expect(JSON.parse(must(calls[0]).body)).toEqual({ remote_url: 'https://github.com/acme/shop.git' });
    });

    it('an agent is told to keep to the terms, and can read them', async () => {
      const instructions = must((await agent(agentA.token)).getInstructions());
      expect(instructions).toContain('Use only those terms');
      expect(instructions).toContain('propose a new one in OpenPurpose');
      const { text } = await call(agentA.token, 'list_terms', { project: 'shop' });
      expect(text).toContain('- Member: Someone who signs in to a Team.');
    });

    it('when OpenPurpose can not be reached, the page says so and review still works', async () => {
      await admin('PUT', '', { url: stubUrl, token: 'op-secret' }); // Clears what was kept.
      answer = { status: 500, body: {} };
      expect(await terms()).toEqual({ state: 'unreachable', terms: [] });
      const ref = await propose();
      expect((await inboxItem(ref)).ref).toBe(ref);
      answer = { status: 200, body: CONTEXT };
    });

    it('a public-only server refuses an internal address', async () => {
      const policy = { mode: 'public' as const, allow: [] };
      await expect(testLink(policy, stubUrl, 'x')).rejects.toThrow(/internal address/);
    });

    it('removing the link turns it all off again', async () => {
      expect((await admin('DELETE', '')).statusCode).toBe(200);
      expect(await terms()).toEqual({ state: 'off', terms: [] });
    });
  });
});
