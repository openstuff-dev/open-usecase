import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('settings', () => {
  it('has a default for every setting', () => {
    expect(loadConfig({})).toMatchObject({ port: 8080, sessionDays: 30, trustProxy: false });
  });
});
