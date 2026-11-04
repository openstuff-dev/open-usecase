import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inbox, InboxItem } from '@open-usecase/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Pool, withScope } from '../src/db.js';
import { addMember, createAgent, createProject, createTeam } from '../src/service/setup.js';

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
    app = await buildApp({ ...loadConfig({}), databaseUrl: url, logLevel: 'silent' }, pool);
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

  describe('UC-1: an agent proposes a use case', () => {
    it('UC-1/S1 a valid proposal returns its IDs, is proposed and reaches the inbox', async () => {
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

    it('UC-1/S2 Gherkin that does not parse is refused with a reason, and nothing arrives', async () => {
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

    it('UC-1/S2 a refused proposal does not use up a use case number', async () => {
      const first = Number((await propose()).slice(3));
      await call(agentA.token, 'propose_usecase', { remote: REMOTE_A, title: 'Broken', gherkin: 'nope' });
      expect(Number((await propose()).slice(3))).toBe(first + 1);
    });

    it.each([
      ['no token', undefined],
      ['an unknown token', 'uc_not-a-real-token'],
    ])('UC-1/S3 a proposal with %s is refused, and nothing arrives', async (_name, token) => {
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

    it('UC-1/S3 a revoked token is refused', async () => {
      const temp = await createAgent(pool, must((await withScope(pool, { bypass: true }, (db) => db.query<{ id: string }>(`SELECT id FROM teams WHERE slug = 'acme'`))).rows[0]).id, 'Temp');
      await expect(agent(temp.token)).resolves.toBeDefined();
      const revoked = await http({ cookie: adminA }, 'DELETE', `/api/t/acme/tokens/${temp.tokenId}`);
      expect(revoked.statusCode).toBe(200);
      await expect(agent(temp.token)).rejects.toThrow();
    });
  });

  describe('UC-2: a person reviews a proposal', () => {
    it('UC-2/S1 a reviewer sees everything they approve, not only names and steps', async () => {
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

    it('UC-2/S1 a member approves a proposal, and it leaves the inbox', async () => {
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

    it('UC-2/S1 approving twice does not decide twice', async () => {
      const { id } = await inboxItem(await propose());
      await http({ cookie: memberA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      const again = await http({ cookie: adminA }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      expect(again.statusCode).toBe(409);
    });

    it('UC-2/S1 an agent cannot approve, not even its own proposal', async () => {
      const ref = await propose();
      const { id } = await inboxItem(ref);
      const response = await http({ token: agentA.token }, 'POST', `/api/t/acme/usecases/${id}/approve`);
      expect(response.statusCode).toBe(403);
      expect((await inboxItem(ref)).id).toBe(id);
    });

    it('UC-2/S2 a member comments on a scenario and asks for changes', async () => {
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

    it('UC-9/S4 asking for changes without saying what is refused, and changes nothing', async () => {
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

    it('UC-9/S4 what the person typed reaches the use case, next to their comments', async () => {
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

    it('UC-2/S2 a comment on a scenario the use case does not have is refused', async () => {
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

    it('UC-2/S3 the agent revises: proposed again, new text in the inbox, comments kept', async () => {
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

    it('UC-2/S3 a different agent cannot revise it', async () => {
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

    it('UC-2/S3 a proposal still waiting for review cannot be revised', async () => {
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

    it('UC-2/S3 a revision with a tag this use case never had is refused', async () => {
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

    it('UC-2/S3 the agent can reply to a comment, on a scenario', async () => {
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

  describe('UC-3: teams and permissions stay apart', () => {
    it("UC-3/S1 a member's inbox has only their own team", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      expect((await inboxItem(ref, memberB, 'bravo')).proposedBy).toBe('Agent B');
      expect((await inbox(memberA)).every((i) => i.proposedBy !== 'Agent B')).toBe(true);
    });

    it("UC-3/S1 asking for another team's inbox directly reads as not found", async () => {
      await propose(GHERKIN, agentB.token, REMOTE_B);
      expect((await http({ cookie: memberA }, 'GET', '/api/t/bravo/inbox')).statusCode).toBe(404);
      expect((await http({ cookie: memberA }, 'GET', '/api/t/nobody/inbox')).statusCode).toBe(404);
    });

    it("UC-3/S1 row-level security hides another team's rows even without a WHERE", async () => {
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

    it("UC-3/S1 a member can't act on another team's use case through their own team", async () => {
      const ref = await propose(GHERKIN, agentB.token, REMOTE_B);
      const { id } = await inboxItem(ref, memberB, 'bravo');
      for (const path of [`/api/t/acme/usecases/${id}/approve`, `/api/t/bravo/usecases/${id}/approve`]) {
        expect((await http({ cookie: memberA }, 'POST', path)).statusCode).toBe(404);
      }
      expect((await inboxItem(ref, memberB, 'bravo')).id).toBe(id);
    });

    it("UC-3/S2 an agent told about another team's use case is told it wasn't found", async () => {
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

    it('UC-3/S2 two teams can have the same remote and still stay apart', async () => {
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

    it('UC-3/S3 an agent gets a 403 for every token and permission change, even its own', async () => {
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

    it('UC-3/S3 MCP offers an agent no way to manage tokens or permissions', async () => {
      const { tools } = await (await agent(agentA.token)).listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'comment_on_usecase',
        'propose_usecase',
        'revise_usecase',
      ]);
    });

    it("UC-3/S3 a person who isn't an admin gets a 403 too, and an admin may", async () => {
      const path = `/api/t/acme/actors/${agentA2.actorId}`;
      expect((await http({ cookie: memberA }, 'PATCH', path, { canReview: true })).statusCode).toBe(403);
      expect((await http({ cookie: adminA }, 'PATCH', path, { canReview: true })).statusCode).toBe(200);
      const made = await http({ cookie: adminA }, 'POST', `${path}/tokens`);
      expect(made.statusCode).toBe(201);
      expect(made.json<{ token: string }>().token).toMatch(/^uc_/);
    });
  });
});
