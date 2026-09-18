// Syncs the tokenizer artifacts (fixed UCI vocabulary, trained BPE model and the Python parity
// fixture) into src/lib/chess-lm/. By default they are copied from the ML repo checked out next
// to this one; `--from <baseUrl>` downloads them instead (e.g. from the Hugging Face Hub).
// Usage: pnpm sync:tokenizer [--from <baseUrl-or-dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localSource = '../rukh/artifacts/tokenizer';
const HUB_SOURCE = 'https://huggingface.co/chorcat/rukh-tokenizer/resolve/main';
const files = ['vocab.json', 'bpe.json', 'fixtures/games.json'];

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
let source = localSource;
if (fromIndex >= 0) {
  source = args[fromIndex + 1] ?? HUB_SOURCE;
  if (source.startsWith('--')) source = HUB_SOURCE;
}
const isUrl = /^https?:\/\//.test(source);

async function read(name) {
  if (isUrl) {
    const url = `${source.replace(/\/$/, '')}/${name}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.text();
  }
  const path = resolve(root, source, name);
  if (!existsSync(path)) throw new Error(`${path}: file not found`);
  return readFileSync(path, 'utf8');
}

try {
  for (const name of files) {
    const text = await read(name);
    JSON.parse(text); // fail early on a truncated download
    const target = resolve(root, 'src/lib/chess-lm', name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text.endsWith('\n') ? text : `${text}\n`);
    console.log(`synced ${name} (${text.length} bytes)`);
  }
  console.log(`tokenizer synced from ${source}`);
} catch (error) {
  console.error(`sync:tokenizer failed: ${error instanceof Error ? error.message : error}`);
  console.error(
    `Expected ${files.join(', ')} under ${source}. Run \`rukh data tokenize --export-fixture\` ` +
      `in ../rukh first, or pass --from ${HUB_SOURCE}.`,
  );
  process.exit(1);
}
