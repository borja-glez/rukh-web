import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../astro.config.mjs';

describe('theme bootstrap script', () => {
  it('has its sha256 allow-listed in the CSP script directive', () => {
    const script = readFileSync(new URL('../src/scripts/theme-init.js', import.meta.url), 'utf8');
    const hash = `sha256-${createHash('sha256').update(script).digest('base64')}`;
    const csp = config.security?.csp;
    const entries = typeof csp === 'object' ? (csp.scriptDirective?.hashes ?? []) : [];
    const hashes = entries.map((entry) => (typeof entry === 'string' ? entry : entry.hash));
    expect(hashes).toContain(hash);
  });
});
