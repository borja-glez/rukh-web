import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import lock from '../src/styles/tokens.lock.json';

describe('tokens.css', () => {
  it('matches the hash recorded in tokens.lock.json (run pnpm sync:tokens to update)', () => {
    const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url));
    const sha256 = createHash('sha256').update(css).digest('hex');
    expect(sha256).toBe(lock.sha256);
  });
});
