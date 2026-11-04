// Sign-in is adapted from OpenAnnounce's auth.ts; actors and hashed tokens from OpenPurpose's.
// No sibling combines the two, so the rule that joins them lives here: a request is either a
// person with a session or an actor with a token, and a token never counts as a person.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import type { Me, ReviewMode, Role } from '@open-usecase/contracts';
import type { Config } from './config.js';
import { queryAcrossTeams, type Client, type Pool } from './db.js';
import { HttpError } from './errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;
export const SESSION_COOKIE = 'ou_session';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** A password people can type: four groups of letters and digits. */
export function newPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const TOKEN_PREFIX = 'uc_';

/** A new token. Only its hash and its start are stored; the token itself is shown once. */
export function newToken(): { token: string; hash: string; prefix: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
  return { token, hash: sha256(token), prefix: token.slice(0, TOKEN_PREFIX.length + 6) };
}

export function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  return /^Bearer\s+(.+)$/i.exec(header.trim())?.[1]?.trim();
}

export interface Account {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
}

/** Who acted, in one team: a person, or an agent with a token. */
export interface Actor {
  id: string;
  teamId: string;
  name: string;
  kind: 'human' | 'agent' | 'ci';
  review: ReviewMode;
  canReview: boolean;
}

/** The actor behind a token, or null if it's unknown or revoked. */
export async function actorFromToken(pool: Pool, token: string | undefined): Promise<Actor | null> {
  if (!token) return null;
  const rows = await queryAcrossTeams<Actor>(
    pool,
    `SELECT a.id, a.team_id AS "teamId", a.name, a.kind, a.review, a.can_review AS "canReview"
       FROM api_tokens t JOIN actors a ON a.id = t.actor_id
      WHERE t.token_hash = ${pg.escapeLiteral(sha256(token))} AND t.revoked_at IS NULL`,
  );
  return rows.at(0) ?? null;
}

declare module 'fastify' {
  interface FastifyRequest {
    account: Account | null;
    /** The request sent a bearer token. It's never treated as a person, whatever else it sent. */
    usedToken: boolean;
    tokenActor: Actor | null;
  }
}

/** Wrong passwords per address and email in the last 15 minutes. */
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 10;

const signIn = z.object({ email: z.email().max(200), password: z.string().min(1).max(200) });

export function registerAuth(app: FastifyInstance, pool: Pool, config: Config): void {
  const secure = config.publicUrl.startsWith('https://');
  app.decorateRequest('account', null);
  app.decorateRequest('usedToken', false);
  app.decorateRequest('tokenActor', null);

  app.addHook('onRequest', async (request) => {
    // /mcp checks its own token, and answers in JSON-RPC.
    if (!request.url.startsWith('/api/')) return;
    const token = bearer(request.headers.authorization);
    if (token) {
      request.usedToken = true;
      request.tokenActor = await actorFromToken(pool, token);
      return;
    }
    const session = request.cookies[SESSION_COOKIE];
    if (!session) return;
    const { rows } = await pool.query<Account>(
      `SELECT a.id, a.email, a.name, a.is_server_admin AS "isServerAdmin"
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(session)],
    );
    request.account = rows.at(0) ?? null;
  });

  // Session cookies are SameSite=Lax, so other sites can't send them with a POST. This also
  // refuses changes from pages on another origin, for browsers that don't do SameSite.
  const ownOrigin = new URL(config.publicUrl).origin;
  app.addHook('onRequest', (request, _reply, done) => {
    const origin = request.headers.origin;
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ||
      !request.url.startsWith('/api/') ||
      request.url.startsWith('/api/v1/') ||
      !origin
    ) {
      done();
      return;
    }
    if (origin !== ownOrigin && origin !== `${request.protocol}://${request.headers.host ?? ''}`) {
      done(new HttpError(403, 'Changes must come from the OpenUsecase app itself.'));
      return;
    }
    done();
  });

  app.post('/api/session', async (request, reply) => {
    const { email, password } = signIn.parse(request.body);
    const key = `${request.ip}|${email.toLowerCase()}`;
    const failed = failures.get(key);
    if (failed && failed.until > Date.now() && failed.count >= MAX_FAILURES) {
      throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
    }
    const { rows } = await pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM accounts WHERE email = $1',
      [email.toLowerCase()],
    );
    // Hash even for unknown emails, so the answer takes as long either way.
    const found = rows.at(0);
    const ok = await verifyPassword(password, found?.password_hash ?? DUMMY_HASH);
    if (!found || !ok) {
      const until = Date.now() + 15 * 60_000;
      const count = (failed && failed.until > Date.now() ? failed.count : 0) + 1;
      failures.set(key, { count, until });
      throw new HttpError(401, 'That email and password don’t match.');
    }
    failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO sessions (token_hash, account_id, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3))`,
      [sha256(token), found.id, config.sessionDays],
    );
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: config.sessionDays * 86400,
    });
    return { ok: true };
  });

  app.delete('/api/session', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (request): Promise<Me> => {
    const account = requirePerson(request);
    const id = pg.escapeLiteral(account.id);
    const teams = await queryAcrossTeams<Me['teams'][number]>(
      pool,
      account.isServerAdmin
        ? `SELECT t.slug, t.name, coalesce(m.role, 'admin') AS role FROM teams t
             LEFT JOIN memberships m ON m.team_id = t.id AND m.account_id = ${id} ORDER BY t.name`
        : `SELECT t.slug, t.name, m.role FROM memberships m JOIN teams t ON t.id = m.team_id
            WHERE m.account_id = ${id} ORDER BY t.name`,
    );
    return { ...account, teams };
  });
}

const DUMMY_HASH = ['scrypt', Buffer.alloc(16).toString('base64'), Buffer.alloc(64).toString('base64')]
  .join('$');

/**
 * The signed-in person. Agents and tokens never get past this: a valid token is a 403, checked
 * first, so no route behind it can be reached with a token, not even for the token's own actor.
 */
export function requirePerson(request: FastifyRequest): Account {
  if (request.usedToken) {
    if (request.tokenActor) {
      throw new HttpError(403, 'Agents can’t do this with a token. A person has to sign in.');
    }
    throw new HttpError(401, 'That token isn’t valid.');
  }
  if (!request.account) throw new HttpError(401, 'Sign in first.');
  return request.account;
}

export interface TeamAccess {
  teamId: string;
  role: Role;
  account: Account;
}

/**
 * What the signed-in person may do in a team. Server admins are admins everywhere. Another team
 * reads as "not found", so nobody learns which teams exist. Every team route goes through this.
 */
export async function teamAccess(
  pool: Pool,
  request: FastifyRequest,
  slug: string,
  allowed: readonly Role[] = ['admin', 'member'],
): Promise<TeamAccess> {
  const account = requirePerson(request);
  const rows = await queryAcrossTeams<{ id: string; role: Role | null }>(
    pool,
    `SELECT t.id, m.role FROM teams t
       LEFT JOIN memberships m ON m.team_id = t.id AND m.account_id = ${pg.escapeLiteral(account.id)}
      WHERE t.slug = ${pg.escapeLiteral(slug)}`,
  );
  const row = rows.at(0);
  const role: Role | null = row ? (account.isServerAdmin ? 'admin' : row.role) : null;
  if (!row || !role) throw new HttpError(404, 'That team wasn’t found.');
  if (!allowed.includes(role)) throw new HttpError(403, 'Only an admin of this team can do that.');
  return { teamId: row.id, role, account };
}

/** The person's actor in this team, made on their first action (server admins may have none). */
export async function personActor(db: Client, access: TeamAccess): Promise<Actor> {
  const { account, teamId } = access;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO actors (team_id, kind, name, account_id) VALUES ($1, 'human', $2, $3)
     ON CONFLICT (team_id, account_id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [teamId, account.name || account.email, account.id],
  );
  return {
    id: rows[0]?.id ?? '',
    teamId,
    name: account.name || account.email,
    kind: 'human',
    review: 'human_approval',
    canReview: false,
  };
}
