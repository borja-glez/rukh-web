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

const VOCAB_SIZE = 2030;
const FIXTURE_GAMES = 20;
const FIXTURE_KEYS = [
  'id',
  'uci',
  'san',
  'white_elo',
  'black_elo',
  'result',
  'uci_ids',
  'san_ids',
  'bpe_ids',
];

/**
 * Rejects a file that parses as JSON but is not the artifact we expect, so a half-written or
 * stale export fails here instead of silently landing in src/lib/chess-lm/.
 */
function validate(name, data) {
  const fail = (why) => {
    throw new Error(`${name}: ${why}`);
  };
  if (name === 'vocab.json') {
    if (!Array.isArray(data?.tokens)) fail('no `tokens` array');
    if (data.tokens.length !== VOCAB_SIZE) {
      fail(`tokens.length is ${data.tokens.length}, expected ${VOCAB_SIZE}`);
    }
    if (!data.tokens.every((token) => typeof token === 'string')) fail('tokens are not strings');
  }
  if (name === 'bpe.json') {
    const model = data?.model;
    if (!model) fail('no `model` object');
    if (!model.vocab || typeof model.vocab !== 'object') fail('no `model.vocab` object');
    if (!Array.isArray(model.merges) || model.merges.length === 0) fail('no `model.merges` list');
  }
  if (name === 'fixtures/games.json') {
    const games = Array.isArray(data) ? data : data?.games;
    if (!Array.isArray(games)) fail('not an array of games');
    if (games.length !== FIXTURE_GAMES) {
      fail(`${games.length} games, expected ${FIXTURE_GAMES}`);
    }
    games.forEach((game, i) => {
      const missing = FIXTURE_KEYS.filter((key) => game?.[key] === undefined);
      if (missing.length > 0) fail(`game ${i} is missing ${missing.join(', ')}`);
    });
  }
}

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
    validate(name, JSON.parse(text)); // fail early on a truncated download or a stale export
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
