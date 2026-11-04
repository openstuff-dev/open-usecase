#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const HELP = `openusecase: upload test reports to OpenUsecase and run its PR check, in CI.

Usage:
  openusecase report [--suite e2e] results.xml
      On the default branch: uploads JUnit XML. Test names carry the scenario ID,
      such as "UC-142/S2 refuses a bad colour". The file isn't stored.
  openusecase check --pr-body body.md [results.xml]
      On a pull request: fails unless the body names approved use cases and every
      scenario has a tagged test. The body says "Use cases: UC-142, UC-150" or
      "No use case: <reason>".

Settings (environment variables, or the flags):
  OPENUSECASE_URL      --url     Where OpenUsecase runs, e.g. https://usecase.example.com
  OPENUSECASE_TOKEN    --token   A CI token from Settings, uc_… (keep it in a CI secret)
  OPENUSECASE_REMOTE   --remote  The git remote. Default: GITHUB_REPOSITORY, or git's origin

The branch and commit come from GITHUB_REF_NAME and GITHUB_SHA, or from git.`;

/** An error to show as is, then exit 1. */
export class CliError extends Error {}

export interface Io {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  readFile: (path: string) => Promise<string>;
  /** Runs git, and answers with its output. */
  git: (...args: string[]) => Promise<string>;
  out: (line: string) => void;
  /** Where errors go. Default: like `out`. */
  err?: (line: string) => void;
}

/** What a PR body says: `Use cases: UC-142, UC-150`, or `No use case: <reason>`. */
export function readPrBody(body: string): { useCases: string[]; exemption?: string } {
  const named = /^\s*use cases?:(.*)$/im.exec(body)?.[1] ?? '';
  const useCases = [...new Set(named.match(/\bUC-\d+\b/g) ?? [])];
  if (useCases.length) return { useCases };
  const exemption = /^\s*no use case:\s*(\S.*)$/im.exec(body)?.[1]?.trim();
  return exemption ? { useCases, exemption } : { useCases };
}

async function fromGit(io: Io, ...args: string[]): Promise<string> {
  try {
    return (await io.git(...args)).trim();
  } catch {
    throw new CliError(`Couldn't run "git ${args.join(' ')}". Set the value in the environment.`);
  }
}

async function remoteOf(io: Io, flag: string | undefined): Promise<string> {
  const given = flag ?? io.env.OPENUSECASE_REMOTE;
  if (given) return given;
  const { GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: server } = io.env;
  if (repository) return `${server ?? 'https://github.com'}/${repository}.git`;
  return fromGit(io, 'remote', 'get-url', 'origin');
}

async function call<T>(
  io: Io,
  settings: { url: string; token: string },
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await io.fetch(`${settings.url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.token}`,
      'content-type': 'application/json',
      'user-agent': 'openusecase-cli',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let answer: unknown = null;
  try {
    answer = JSON.parse(text);
  } catch {
    // Not JSON: a proxy's error page, say. The status below says enough.
  }
  if (!response.ok) {
    const message = (answer as { error?: string } | null)?.error;
    throw new CliError(message ?? `OpenUsecase answered ${String(response.status)}.`);
  }
  return answer as T;
}

interface ReportAnswer {
  scenarios: number;
  unknownTags: string[];
  wentLive: string[];
}

interface CheckAnswer {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Runs the CLI and answers with the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  const err = io.err ?? io.out;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        token: { type: 'string' },
        remote: { type: 'string' },
        suite: { type: 'string' },
        branch: { type: 'string' },
        commit: { type: 'string' },
        'pr-body': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    err((error as Error).message);
    return 1;
  }
  const { values, positionals } = parsed;
  const [command, file] = positionals;
  if (values.help || !command) {
    io.out(HELP);
    return values.help ? 0 : 1;
  }
  try {
    const url = (values.url ?? io.env.OPENUSECASE_URL ?? '').replace(/\/$/, '');
    const token = values.token ?? io.env.OPENUSECASE_TOKEN ?? '';
    if (!url) throw new CliError('Set OPENUSECASE_URL, or pass --url.');
    if (!token) throw new CliError('Set OPENUSECASE_TOKEN, or pass --token.');
    const settings = { url, token };

    if (command === 'report') {
      if (!file) throw new CliError('Say which JUnit file to upload: openusecase report results.xml');
      const commit =
        values.commit ?? io.env.GITHUB_SHA ?? (await fromGit(io, 'rev-parse', 'HEAD'));
      const suite = values.suite ?? 'default';
      const answer = await call<ReportAnswer>(
        io,
        settings,
        '/api/v1/reports',
        {
          remote: await remoteOf(io, values.remote),
          branch:
            values.branch ??
            io.env.GITHUB_REF_NAME ??
            (await fromGit(io, 'rev-parse', '--abbrev-ref', 'HEAD')),
          suite,
          commit,
          junit: await io.readFile(file),
        },
        `report-${suite}-${commit}`,
      );
      io.out(`Reported ${String(answer.scenarios)} scenario(s) in suite "${suite}".`);
      if (answer.wentLive.length) io.out(`Now live: ${answer.wentLive.join(', ')}.`);
      if (answer.unknownTags.length) {
        io.out(`These IDs aren't known or are retired: ${answer.unknownTags.join(', ')}.`);
      }
      return 0;
    }

    if (command === 'check') {
      if (!values['pr-body']) {
        throw new CliError('Say where the PR body is: openusecase check --pr-body body.md results.xml');
      }
      const answer = await call<CheckAnswer>(io, settings, '/api/v1/check', {
        remote: await remoteOf(io, values.remote),
        ...readPrBody(await io.readFile(values['pr-body'])),
        ...(file ? { junit: await io.readFile(file) } : {}),
      });
      for (const note of answer.notes) io.out(note);
      for (const problem of answer.problems) err(problem);
      if (answer.ok) io.out('The use case check passed.');
      return answer.ok ? 0 : 1;
    }

    throw new CliError(`Unknown command "${command}". Use report or check.`);
  } catch (error) {
    if (error instanceof CliError) {
      err(error.message);
      return 1;
    }
    err(`Couldn't reach OpenUsecase: ${(error as Error).message}`);
    return 1;
  }
}

const isMain = async () =>
  !!process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url);

if (await isMain()) {
  const git = promisify(execFile);
  process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    fetch: (...args) => globalThis.fetch(...args),
    readFile: (path) => readFile(path, 'utf8'),
    git: async (...args) => (await git('git', args)).stdout,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  });
}
