// Syncs src/styles/tokens.css from the course repo (source of truth) or from a URL, then
// rewrites tokens.lock.json. Usage: pnpm sync:tokens [--from <path-or-url>]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = '../rukh-lab/src/styles/tokens.css';
const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const source = fromIndex >= 0 ? args[fromIndex + 1] : defaultSource;

if (!source) {
  console.error('usage: node scripts/sync-tokens.mjs [--from <path-or-url>]');
  process.exit(1);
}

async function readSource(spec) {
  if (/^https?:\/\//.test(spec)) {
    const response = await fetch(spec);
    if (!response.ok) throw new Error(`${spec}: HTTP ${response.status}`);
    return response.text();
  }
  return readFileSync(resolve(root, spec), 'utf8');
}

const css = await readSource(source);
const target = resolve(root, 'src/styles/tokens.css');
writeFileSync(target, css);

const lock = {
  sha256: createHash('sha256').update(css).digest('hex'),
  source,
  syncedAt: new Date().toISOString().slice(0, 10),
};
writeFileSync(resolve(root, 'src/styles/tokens.lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(`tokens.css synced from ${source} (${lock.sha256})`);
