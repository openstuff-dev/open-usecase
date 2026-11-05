import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('favicon', () => {
  it('shows the same mark in the app as on the project page', () => {
    const app = read('../../web/public/favicon.svg');
    expect(app).toBe(read('../../../site/favicon.svg'));
    expect(app).toContain('<title>OpenUsecase</title>');
  });
});
