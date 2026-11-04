// Adapted from OpenVersion's crypto.ts.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Pool } from './db.js';

/** Encrypts and decrypts integration tokens with AES-256-GCM. */
export interface Vault {
  seal(plain: string): string;
  open(sealed: string): string;
}

export function vaultFor(secret: string): Vault {
  const key = createHash('sha256').update(secret).digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
    },
    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== 3) throw new Error('This token is damaged. Enter it again.');
      const [iv, tag, data] = parts.map((part) => Buffer.from(part, 'base64url')) as [
        Buffer,
        Buffer,
        Buffer,
      ];
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      } catch {
        throw new Error('This token can’t be read with the current secret key. Enter it again.');
      }
    },
  };
}

/**
 * The vault for OPENUSECASE_SECRET_KEY. Without that setting, a key is made on first start and kept
 * in the database, with a warning: a database dump alone could then reveal the tokens.
 */
export async function loadVault(
  pool: Pool,
  config: Config,
  log: FastifyBaseLogger,
): Promise<Vault> {
  if (config.secretKey) return vaultFor(config.secretKey);
  const { rows } = await pool.query<{ value: string }>(
    `INSERT INTO server_settings (name, value) VALUES ('secret_key', $1)
     ON CONFLICT (name) DO UPDATE SET value = server_settings.value RETURNING value`,
    [randomBytes(32).toString('base64url')],
  );
  log.warn(
    'OPENUSECASE_SECRET_KEY isn’t set, so the OpenPurpose token is encrypted with a key kept in the ' +
    'database. Set it on a server, so a database dump alone can’t reveal the token.',
  );
  return vaultFor((rows[0]).value);
}
