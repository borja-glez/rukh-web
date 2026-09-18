// Prints the sha256 of src/styles/tokens.css. With --write, stores it in tokens.lock.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = resolve(root, 'src/styles/tokens.css');
const lockPath = resolve(root, 'src/styles/tokens.lock.json');

export function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const sha256 = hashFile(tokensPath);
console.log(sha256);

if (process.argv.includes('--write')) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.sha256 = sha256;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  console.log(`updated ${lockPath}`);
}
