import type { Glossary, GlossaryTerm } from '@open-usecase/contracts';
import type { Vault } from '../crypto.js';
import type { Client } from '../db.js';
import { HttpError } from '../errors.js';
import { type FetchPolicy, FetchRefused, safeFetch } from '../safe-fetch.js';

/** The part of OpenPurpose's `POST /api/context` answer this needs: its layers, general first. */
interface ContextAnswer {
  blocks?: { documents?: { kind?: string; sections?: { heading?: string; body?: string }[] }[] }[];
}

const FRESH_FOR = 5 * 60_000;
/** Not long, so a brief outage clears up by itself. */
const FAILED_FOR = 30_000;

/** `[[Member]]` reads as "Member" in a definition. */
const plain = (text: string) =>
  text.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * Reads a project's glossary from OpenPurpose, which stays the only source of terms. The answer is
 * kept for a few minutes per team and repository, so the inbox doesn't call it on every page.
 */
export class GlossaryReader {
  private readonly cache = new Map<string, { until: number; glossary: Glossary }>();

  constructor(
    private readonly policy: FetchPolicy,
    private readonly vault: Vault,
  ) {}

  /** Forgets a team's answers, when its link changes. */
  forget(teamId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${teamId}|`)) this.cache.delete(key);
    }
  }

  async read(db: Client, teamId: string, projectSlug: string): Promise<Glossary> {
    const { rows } = await db.query<{ url: string; sealed: string; remote: string | null }>(
      `SELECT l.url, l.token_sealed AS sealed,
              (SELECT r.remote_key FROM repositories r JOIN projects p ON p.id = r.project_id
                WHERE p.slug = $1 ORDER BY r.created_at LIMIT 1) AS remote
         FROM openpurpose_links l`,
      [projectSlug],
    );
    const link = rows.at(0);
    if (!link) return { state: 'off', terms: [] };
    if (!link.remote) return { state: 'ok', terms: [] };
    const key = `${teamId}|${link.remote}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.glossary;
    const glossary = await this.fetch(link.url, link.sealed, link.remote);
    this.cache.set(key, {
      until: Date.now() + (glossary.state === 'ok' ? FRESH_FOR : FAILED_FOR),
      glossary,
    });
    return glossary;
  }

  private async fetch(url: string, sealed: string, remote: string): Promise<Glossary> {
    try {
      const response = await safeFetch(`${url}/api/context`, this.policy, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.vault.open(sealed)}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'OpenUsecase',
        },
        body: JSON.stringify({ remote_url: `https://${remote}.git` }),
      });
      if (response.status !== 200) return { state: 'unreachable', terms: [] };
      return { state: 'ok', terms: termsIn(JSON.parse(response.body) as ContextAnswer) };
    } catch {
      return { state: 'unreachable', terms: [] };
    }
  }
}

/** The glossary documents of every layer. A more specific layer's definition wins. */
export function termsIn(answer: ContextAnswer): GlossaryTerm[] {
  const terms = new Map<string, GlossaryTerm>();
  for (const block of answer.blocks ?? []) {
    for (const document of block.documents ?? []) {
      if (document.kind !== 'glossary') continue;
      for (const section of document.sections ?? []) {
        const term = plain(section.heading ?? '');
        if (term) terms.set(term.toLowerCase(), { term, definition: plain(section.body ?? '') });
      }
    }
  }
  return [...terms.values()].sort((a, b) => a.term.localeCompare(b.term));
}

/** Checks the URL and token against OpenPurpose before saving them. */
export async function testLink(policy: FetchPolicy, url: string, token: string): Promise<void> {
  try {
    const response = await safeFetch(`${url}/api/me`, policy, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(400, 'OpenPurpose refused that token.');
    }
    if (response.status !== 200) {
      throw new HttpError(400, `OpenPurpose answered ${String(response.status)}. Check the URL.`);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof FetchRefused) throw new HttpError(400, error.message);
    throw new HttpError(400, `Couldn’t reach ${url}: ${(error as Error).message}`);
  }
}
