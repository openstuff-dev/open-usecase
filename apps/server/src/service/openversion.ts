import type { FastifyBaseLogger } from 'fastify';
import { FetchRefused, type FetchPolicy, safeFetch } from '../safe-fetch.js';

export interface ConnectionAnswer {
  ok: boolean;
  message: string;
}

/** Tests a deploy token by reading the live release. Never throws: a failure is an answer. */
export async function testOpenVersion(
  policy: FetchPolicy,
  url: string,
  deployToken: string,
): Promise<ConnectionAnswer> {
  try {
    const response = await safeFetch(`${url}/api/v1/releases/live`, policy, {
      method: 'GET',
      headers: { authorization: `Bearer ${deployToken}`, accept: 'application/json' },
    });
    if (response.status === 200) {
      return { ok: true, message: 'Connected. OpenVersion answered with the live release.' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'OpenVersion doesn’t recognise this deploy token.' };
    }
    return { ok: false, message: `OpenVersion answered ${String(response.status)}. Check the address.` };
  } catch (error) {
    if (error instanceof FetchRefused) return { ok: false, message: error.message };
    return { ok: false, message: 'That address didn’t answer.' };
  }
}

export type PublishOutcome = 'skipped' | 'published' | 'not-newer' | 'refused' | 'failed';

/**
 * Publishes this image's version to OpenVersion when the server starts, so open tabs learn about it
 * with no CI step. The version is the idempotency key, so replicas starting together publish once.
 * OpenVersion refuses a version that isn't higher than the live one: that answer is fine and
 * leaves what's live alone, so starting an older image never rolls anything back. Never throws.
 */
export async function publishOwnVersion(
  policy: FetchPolicy,
  connection: { url: string; deployToken: string },
  version: string,
  log: FastifyBaseLogger,
): Promise<PublishOutcome> {
  if (version === '0.0.0') return 'skipped';
  try {
    const response = await safeFetch(`${connection.url}/api/v1/releases`, policy, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${connection.deployToken}`,
        'content-type': 'application/json',
        'idempotency-key': `openusecase-${version}`,
        'user-agent': 'openusecase-server',
      },
      body: JSON.stringify({ version, notes: '' }),
      timeout: 10_000,
    });
    if (response.status === 201) {
      log.info({ version }, 'Published this version to OpenVersion.');
      return 'published';
    }
    if (response.status === 409) {
      log.info({ version }, 'OpenVersion already has this version or a newer one live.');
      return 'not-newer';
    }
    if (response.status === 401 || response.status === 403) {
      log.warn('OpenVersion refused the deploy token, so this version was not published.');
      return 'refused';
    }
    log.warn({ status: response.status }, 'OpenVersion did not accept this version.');
    return 'failed';
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'Could not reach OpenVersion to publish.');
    return 'failed';
  }
}

/**
 * The connection the server publishes with on start: the environment's, else the saved one. A saved
 * token that can't be read (for example after the secret key changed) is skipped, not an error.
 */
export async function connectionFor(
  pool: {
    query: (sql: string) => Promise<{
      rows: { url: string; deploy_token_sealed: string | null }[];
    }>;
  },
  config: { openVersion: { url: string | undefined; deployToken: string | undefined } },
  vault: { open: (sealed: string) => string },
): Promise<{ url: string; deployToken: string } | null> {
  if (config.openVersion.url && config.openVersion.deployToken) {
    return { url: config.openVersion.url, deployToken: config.openVersion.deployToken };
  }
  const { rows } = await pool.query(
    `SELECT url, deploy_token_sealed FROM server_integrations WHERE kind = 'openversion'`,
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (!row.deploy_token_sealed) return null;
  try {
    return { url: row.url, deployToken: vault.open(row.deploy_token_sealed) };
  } catch {
    return null;
  }
}
