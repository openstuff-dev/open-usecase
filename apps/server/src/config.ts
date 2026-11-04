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
  /** Encrypts the OpenPurpose token. Without it, a key is made and kept in the database. */
  secretKey: string | undefined;
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
    fetch: env.OPENUSECASE_FETCH === 'private' ? 'private' : 'public',
    fetchAllow: (env.OPENUSECASE_FETCH_ALLOW ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  };
}
