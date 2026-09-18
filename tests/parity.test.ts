// Parity with the Python tokenizers (`rukh/src/rukh/tokenize/`). The JSON files under
// src/lib/chess-lm/ are synced from ../rukh/artifacts/tokenizer with `pnpm sync:tokenizer`; these
// tests fail (never skip) when they are missing.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildVocab, UciTokenizer } from '../src/lib/chess-lm/tokenizer';
import { SanCharTokenizer } from '../src/lib/chess-lm/san-chars';
import { loadBpe, type BpeFile } from '../src/lib/chess-lm/bpe';

const dir = resolve(import.meta.dirname, '../src/lib/chess-lm');

interface VocabFile {
  version: number;
  specials: string[];
  tokens: string[];
}

interface FixtureGame {
  uci: string;
  san: string;
  white_elo: number;
  black_elo: number;
  result: string;
  uci_ids: number[];
  san_ids: number[];
  bpe_ids: number[];
}

interface FixtureFile {
  games: FixtureGame[];
}

function readJson<T>(name: string): T {
  const path = resolve(dir, name);
  if (!existsSync(path)) {
    throw new Error(`fixture missing: ${path} (run \`pnpm sync:tokenizer\`)`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function readGames(): FixtureGame[] {
  const fixture = readJson<FixtureFile | FixtureGame[]>('fixtures/games.json');
  const games = Array.isArray(fixture) ? fixture : fixture.games;
  if (!Array.isArray(games) || games.length === 0) {
    throw new Error('fixture missing: fixtures/games.json has no games');
  }
  return games;
}

describe('parity with Python', () => {
  it('vocab.json matches buildVocab() one to one', () => {
    const vocab = readJson<VocabFile>('vocab.json');
    expect(vocab.tokens).toEqual(buildVocab());
    expect(vocab.tokens.slice(0, vocab.specials.length)).toEqual(vocab.specials);
  });

  it('fixtures/games.json has 20 games', () => {
    expect(readGames()).toHaveLength(20);
  });

  it('UciTokenizer.encodeGame reproduces uci_ids', () => {
    const tokenizer = new UciTokenizer();
    for (const [i, game] of readGames().entries()) {
      expect(
        tokenizer.encodeGame(game.uci, game.white_elo, game.black_elo, game.result),
        `game ${i}`,
      ).toEqual(game.uci_ids);
    }
  });

  it('SanCharTokenizer.encode reproduces san_ids', () => {
    const tokenizer = new SanCharTokenizer();
    for (const [i, game] of readGames().entries()) {
      expect(tokenizer.encode(`${game.san} ${game.result}`), `game ${i}`).toEqual(game.san_ids);
    }
  });

  it('loadBpe(bpe.json).encode reproduces bpe_ids', () => {
    const bpe = loadBpe(readJson<BpeFile>('bpe.json'));
    for (const [i, game] of readGames().entries()) {
      expect(bpe.encode(game.uci), `game ${i}`).toEqual(game.bpe_ids);
    }
  });
});
