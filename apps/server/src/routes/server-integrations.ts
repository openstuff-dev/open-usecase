import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requirePerson } from '../auth.js';
import type { Config } from '../config.js';
import type { Vault } from '@openstuff-dev/server';
import { type Pool } from '../db.js';
import { HttpError } from '../errors.js';
import type { FetchPolicy } from '@openstuff-dev/server';
import { type ConnectionAnswer, testOpenVersion } from '../service/openversion.js';

/**
 * One server-wide connection, as the Integrations tab shows it.
 * The deploy token is never included.
 */
export interface ServerIntegration {
  kind: 'openversion';
  url: string | null;
  publicKey: string | null;
  hasDeployToken: boolean;
  status: 'not-connected' | 'connected' | 'problem' | 'set-by-server';
  source: 'database' | 'environment' | null;
  message: string | null;
  testedAt: string | null;
}

const publicKey = z.string().trim().min(8, 'Paste the whole public key.').max(200);
const deployToken = z
  .string()
  .trim()
  .min(8, 'Paste the whole deploy token.')
  .max(500);
const baseUrl = z.url().max(500).transform((url) => url.replace(/\/+$/, ''));

interface Row {
  url: string;
  public_key: string;
  has_token: boolean;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_tested_at: Date | null;
}

/** The server-wide OpenVersion connection. Only server admins read or change it. */
export function registerServerIntegrationRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: Config,
  policy: FetchPolicy,
  vault: Vault,
  check: (url: string, token: string) => Promise<ConnectionAnswer> = (url, token) =>
    testOpenVersion(policy, url, token),
): void {
  const fromEnv =
    config.openVersion.url && config.openVersion.publicKey && config.openVersion.deployToken
      ? { url: config.openVersion.url, publicKey: config.openVersion.publicKey }
      : null;

  const serverAdmin = (request: FastifyRequest) => {
    if (!requirePerson(request).isServerAdmin) {
      throw new HttpError(403, 'Only a server admin can manage server connections.');
    }
  };

  const loadRow = async (): Promise<Row | undefined> => {
    const { rows } = await pool.query<Row>(
      `SELECT url, public_key, deploy_token_sealed IS NOT NULL AS has_token, last_test_ok,
              last_test_message, last_tested_at
         FROM server_integrations WHERE kind = 'openversion'`,
    );
    return rows[0];
  };

  const card = (row: Row | undefined): ServerIntegration => {
    if (fromEnv) {
      return {
        kind: 'openversion',
        url: fromEnv.url,
        publicKey: fromEnv.publicKey,
        hasDeployToken: true,
        status: 'set-by-server',
        source: 'environment',
        message: null,
        testedAt: null,
      };
    }
    if (!row) {
      return {
        kind: 'openversion',
        url: null,
        publicKey: null,
        hasDeployToken: false,
        status: 'not-connected',
        source: null,
        message: null,
        testedAt: null,
      };
    }
    return {
      kind: 'openversion',
      url: row.url,
      publicKey: row.public_key,
      hasDeployToken: row.has_token,
      status: row.last_test_ok === false ? 'problem' : 'connected',
      source: 'database',
      message: row.last_test_message,
      testedAt: row.last_tested_at?.toISOString() ?? null,
    };
  };

  app.get('/api/admin/integrations', async (request): Promise<ServerIntegration[]> => {
    serverAdmin(request);
    return [card(await loadRow())];
  });

  /** Saves the connection, then tests it. The save happens either way, so a fix can follow. */
  app.put('/api/admin/integrations/openversion', async (request): Promise<ServerIntegration> => {
    serverAdmin(request);
    if (fromEnv) {
      throw new HttpError(
        409,
        'The server’s configuration sets this. Change OPENUSECASE_OPENVERSION_URL to change it here.',
      );
    }
    const body = z
      .object({ url: baseUrl, publicKey, deployToken })
      .parse(request.body);
    const result = await check(body.url, body.deployToken);
    const sealed = vault.seal(body.deployToken);
    await pool.query(
      `INSERT INTO server_integrations (kind, url, public_key, deploy_token_sealed, last_test_ok, last_test_message, last_tested_at, updated_at)
       VALUES ('openversion', $1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (kind) DO UPDATE SET url = EXCLUDED.url, public_key = EXCLUDED.public_key,
         deploy_token_sealed = EXCLUDED.deploy_token_sealed,
         last_test_ok = EXCLUDED.last_test_ok, last_test_message = EXCLUDED.last_test_message,
         last_tested_at = now(), updated_at = now()`,
      [body.url, body.publicKey, sealed, result.ok, result.message],
    );
    return card(await loadRow());
  });

  /** Tests the saved connection, or the values sent. Saved results are kept; new values are not. */
  app.post('/api/admin/integrations/openversion/test', async (request): Promise<ConnectionAnswer> => {
    serverAdmin(request);
    const body = z
      .object({ url: baseUrl.optional(), deployToken: deployToken.optional() })
      .parse(request.body ?? {});
    const saved = await loadRow();
    const url = body.url ?? (fromEnv ? fromEnv.url : saved?.url);
    if (!url) throw new HttpError(400, 'Enter the OpenVersion address first.');
    const token = body.deployToken ?? (fromEnv ? config.openVersion.deployToken : undefined);
    if (!token) throw new HttpError(400, 'Enter the deploy token first.');
    const result = await check(url, token);
    const testsSaved = !fromEnv && saved !== undefined && !body.url && !body.deployToken;
    if (testsSaved) {
      await pool.query(
        `UPDATE server_integrations SET last_test_ok = $1, last_test_message = $2, last_tested_at = now()
          WHERE kind = 'openversion'`,
        [result.ok, result.message],
      );
    }
    return result;
  });

  app.delete('/api/admin/integrations/openversion', async (request): Promise<{ ok: true }> => {
    serverAdmin(request);
    if (fromEnv) {
      throw new HttpError(
        409,
        'The server’s configuration sets this. Remove OPENUSECASE_OPENVERSION_URL to disconnect it here.',
      );
    }
    await pool.query("DELETE FROM server_integrations WHERE kind = 'openversion'");
    return { ok: true };
  });

  /** Public values only, so the web app can load its OpenVersion client. Never a token. */
  app.get('/api/client-config', async (): Promise<{ openversion: { url: string; publicKey: string } | null }> => {
    if (fromEnv) return { openversion: fromEnv };
    const row = await loadRow();
    return { openversion: row ? { url: row.url, publicKey: row.public_key } : null };
  });
}
