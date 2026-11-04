import { describe, expect, it, vi } from 'vitest';
import { type Io, readPrBody, run } from '../src/index.js';

function io(
  answer: unknown = { scenarios: 2, unknownTags: [], wentLive: [] },
  status = 200,
  env: Record<string, string> = {},
) {
  const lines: string[] = [];
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(answer), { status })));
  const value: Io = {
    env: { OPENUSECASE_URL: 'https://uc.test/', OPENUSECASE_TOKEN: 'uc_abc', ...env },
    fetch,
    readFile: (path) =>
      path === 'body.md'
        ? Promise.resolve('Fixes it.\n\nUse cases: UC-1, UC-22\n')
        : Promise.resolve('<testsuites/>'),
    git: (...args) =>
      Promise.resolve(
        args[0] === 'remote'
          ? 'git@github.com:acme/shop.git\n'
          : args.includes('--abbrev-ref')
            ? 'main\n'
            : 'abc123\n',
      ),
    out: (line) => lines.push(line),
  };
  const sent = () => {
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    return {
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
  };
  return { io: value, lines, sent };
}

describe('openusecase report', () => {
  it('UC-15/S1 uploads the file with what git says, and the token', async () => {
    const t = io();
    expect(await run(['report', '--suite', 'e2e', 'results.xml'], t.io)).toBe(0);
    const { url, headers, body } = t.sent();
    expect(url).toBe('https://uc.test/api/v1/reports');
    expect(headers.authorization).toBe('Bearer uc_abc');
    expect(headers['idempotency-key']).toBe('report-e2e-abc123');
    expect(body).toEqual({
      remote: 'git@github.com:acme/shop.git',
      branch: 'main',
      suite: 'e2e',
      commit: 'abc123',
      junit: '<testsuites/>',
    });
    expect(t.lines[0]).toBe('Reported 2 scenario(s) in suite "e2e".');
  });

  it('UC-15/S1 prefers what GitHub Actions says', async () => {
    const t = io(undefined, 200, {
      GITHUB_REPOSITORY: 'acme/web',
      GITHUB_REF_NAME: 'trunk',
      GITHUB_SHA: 'def456',
    });
    await run(['report', 'results.xml'], t.io);
    expect(t.sent().body).toMatchObject({
      remote: 'https://github.com/acme/web.git',
      branch: 'trunk',
      commit: 'def456',
      suite: 'default',
    });
  });

  it('UC-16/S1 says what went live, and which IDs are unknown', async () => {
    const t = io({ scenarios: 1, unknownTags: ['UC-9/S1'], wentLive: ['UC-1'] });
    await run(['report', 'results.xml'], t.io);
    expect(t.lines).toContain('Now live: UC-1.');
    expect(t.lines).toContain("These IDs aren't known or are retired: UC-9/S1.");
  });

  it('UC-15/S6 shows the refusal from the server and exits 1', async () => {
    const t = io({ error: 'Reports only count from the default branch, main.' }, 409);
    expect(await run(['report', 'results.xml'], t.io)).toBe(1);
    expect(t.lines).toEqual(['Reports only count from the default branch, main.']);
  });

  it('says what is missing without a URL or token', async () => {
    const t = io();
    t.io.env = {};
    expect(await run(['report', 'results.xml'], t.io)).toBe(1);
    expect(t.lines[0]).toContain('OPENUSECASE_URL');
  });
});

describe('openusecase check', () => {
  it('UC-17/S6 sends the use cases and the test run, and passes', async () => {
    const t = io({ ok: true, problems: [], notes: [] });
    expect(await run(['check', '--pr-body', 'body.md', 'results.xml'], t.io)).toBe(0);
    expect(t.sent().url).toBe('https://uc.test/api/v1/check');
    expect(t.sent().body).toMatchObject({ useCases: ['UC-1', 'UC-22'], junit: '<testsuites/>' });
    expect(t.lines).toContain('The use case check passed.');
  });

  it('UC-17/S4 prints every problem and exits 1', async () => {
    const t = io({ ok: false, problems: ['UC-1/S2 has no tagged test.'], notes: [] });
    expect(await run(['check', '--pr-body', 'body.md'], t.io)).toBe(1);
    expect(t.lines).toEqual(['UC-1/S2 has no tagged test.']);
  });

  it('UC-17/S1 reads the PR body in both forms', () => {
    expect(readPrBody('use case: UC-3\nUse cases: UC-3').useCases).toEqual(['UC-3']);
    expect(readPrBody('Text\nNo use case: Dependency bump.')).toEqual({
      useCases: [],
      exemption: 'Dependency bump.',
    });
    expect(readPrBody('Mentions UC-3 in passing.')).toEqual({ useCases: [] });
    expect(readPrBody('No use case:   ')).toEqual({ useCases: [] });
  });
});
