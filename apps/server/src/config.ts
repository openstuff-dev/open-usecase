import type { FetchPolicy } from '@openstuff-dev/server';
/** Settings from environment variables. Each has a default, so the server starts without any. */
export interface Config {
  port: number;
  host: string;
  /** The built web app to serve next to the API, if any. */
  webDir: string | undefined;
  logLevel: string;
  databaseUrl: string;
  /** Where people reach OpenUsecase. Used for cookies and the same-origin check. */
  publicUrl: string;
  /** The first admin's email and password. Without a password, one is made and logged once. */
  adminEmail: string;
  adminPassword: string | undefined;
  sessionDays: number;
  /** Behind a reverse proxy: true, or the proxy's addresses. */
  trustProxy: boolean | string;
  /** The largest test report CI may upload. */
  reportMaxBytes: number;
  /**
   * Encrypts the OpenPurpose token and the connection secrets. Without it, a key is made and
   * kept in the database.
   */
  secretKey: string | undefined;
  /**
   * A server-wide OpenVersion connection from the environment. When the URL and public key are
   * both set, they win over the one saved in the Integrations tab, which then shows read-only.
   * The deploy token also lets this server publish its own version on start.
   */
  openVersion: {
    url: string | undefined;
    publicKey: string | undefined;
    deployToken: string | undefined;
  };
  /** OpenAnnounce, the same way. The signing secret lets messages be aimed at a team or role. */
  openAnnounce: {
    url: string | undefined;
    publicKey: string | undefined;
    signingSecret: string | undefined;
  };
  /** The release this image was built from, set by the image build. `unknown` for a local build. */
  appVersion: string;
  /** `private` lets this server call internal addresses, such as an OpenPurpose on your network. */
  fetch: 'public' | 'private';
  /** With `private`: only these hosts. Empty means any. */
  fetchAllow: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trust = env.OPENUSECASE_TRUST_PROXY ?? '';
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    webDir: env.WEB_DIR || undefined,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: env.DATABASE_URL ?? 'postgres://openusecase:openusecase@localhost:5432/openusecase',
    publicUrl: (env.OPENUSECASE_PUBLIC_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    adminEmail: (env.OPENUSECASE_ADMIN_EMAIL ?? 'admin@example.com').toLowerCase(),
    adminPassword: env.OPENUSECASE_ADMIN_PASSWORD || undefined,
    sessionDays: Number(env.OPENUSECASE_SESSION_DAYS ?? 30),
    trustProxy: trust === 'true' ? true : trust || false,
    reportMaxBytes: Number(env.OPENUSECASE_REPORT_MAX_BYTES ?? 20 * 1024 * 1024),
    secretKey: env.OPENUSECASE_SECRET_KEY || undefined,
    openVersion: {
      url: env.OPENUSECASE_OPENVERSION_URL?.replace(/\/$/, '') || undefined,
      publicKey: env.OPENUSECASE_OPENVERSION_PUBLIC_KEY || undefined,
      deployToken: env.OPENUSECASE_OPENVERSION_DEPLOY_TOKEN || undefined,
    },
    openAnnounce: {
      url: env.OPENUSECASE_OPENANNOUNCE_URL?.replace(/\/$/, '') || undefined,
      publicKey: env.OPENUSECASE_OPENANNOUNCE_PUBLIC_KEY || undefined,
      signingSecret: env.OPENUSECASE_OPENANNOUNCE_SIGNING_SECRET || undefined,
    },
    appVersion: env.VERSION?.trim() || 'unknown',
    fetch: env.OPENUSECASE_FETCH === 'private' ? 'private' : 'public',
    fetchAllow: (env.OPENUSECASE_FETCH_ALLOW ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}

/** The fetch policy integrations use, from OPENUSECASE_FETCH and OPENUSECASE_FETCH_ALLOW. */
export const policyFrom = (config: Config): FetchPolicy => ({
  mode: config.fetch,
  allow: config.fetchAllow,
  envPrefix: 'OPENUSECASE',
});
